/**
 * LLM extraction layer (optional).
 * If OPENAI_API_KEY is set, uses an OpenAI-compatible chat API to extract
 * structured leadership info from page text and to pick the best LinkedIn match.
 * Falls back to heuristic extraction when no key is configured.
 */

require('./env'); // populate process.env from .env before reading the key

const fs = require('fs');
const path = require('path');

const {
  isValidPersonName,
  cleanName,
  normalizeDesignation,
  companyTokensOf,
} = require('./person');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const llmEnabled = () => Boolean(OPENAI_API_KEY);

async function chat(messages, { maxTokens = 1500, temperature = 0 } = {}) {
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * instructions.md holds the project's own extraction/verification spec.
 * Nothing used to read it, so the model ran on weaker inline prompts. The two
 * MODE sections are loaded here and used as the behavioural rules, with a
 * fixed output-format footer appended so the JSON contract stays stable.
 */
const INSTRUCTIONS_PATH = path.join(__dirname, '..', 'instructions.md');

function loadModeInstructions() {
  try {
    const raw = fs.readFileSync(INSTRUCTIONS_PATH, 'utf-8');
    const mode1 = raw.match(/MODE 1[\s\S]*?(?=MODE 2|$)/i);
    const mode2 = raw.match(/MODE 2[\s\S]*?(?=\n---|$)/i);
    return {
      extract: mode1 ? mode1[0].trim() : null,
      verify: mode2 ? mode2[0].trim() : null,
    };
  } catch {
    return { extract: null, verify: null };
  }
}

const MODE = loadModeInstructions();

function safeJsonParse(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw.trim());
  } catch {
    const start = raw.search(/[[{]/);
    const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

/**
 * Extract directors/leaders from raw page text.
 * Returns [{ name, designation }] or null on failure.
 */
async function extractLeadersWithLlm(pageText, companyName) {
  if (!llmEnabled() || !pageText || pageText.length < 30) return null;

  // Keep context manageable
  const text = pageText.slice(0, 12000);

  const rules =
    MODE.extract ||
    `MODE 1 — EXTRACTING FROM A COMPANY'S OWN WEBSITE
Identify named senior executives. Extract a person ONLY if their full name
appears explicitly and a specific title is stated (CEO, CFO, COO, CTO,
Managing Director, Founder, Co-Founder, Chairman, President, Executive
Director, or a close equivalent). Do NOT extract people mentioned only in
passing, former titleholders, board members without an operating title, or
anyone whose name or title is ambiguous.`;

  const system = `You are a contact-resolution agent for a company research tool.

${rules}

OUTPUT FORMAT
Respond with ONLY a JSON array, no prose and no code fences:
[{"name": "Full Name", "designation": "Stated Title"}]
Return [] if nobody qualifies.`;

  const user = `Company: ${companyName}\n\nWebsite text:\n"""\n${text}\n"""`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await chat([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);
      const parsed = safeJsonParse(content);
      if (Array.isArray(parsed)) {
        const companyTokens = companyTokensOf(companyName);
        // The model still hallucinates section headings as people, so the
        // same strict name rules the crawler uses are applied here too.
        return parsed
          .filter((p) => p && typeof p.name === 'string')
          .map((p) => ({
            name: cleanName(p.name),
            designation: normalizeDesignation(p.designation || ''),
          }))
          .filter((p) => isValidPersonName(p.name, { companyTokens }) && p.designation);
      }
    } catch (_) {
      /* retry once then give up */
    }
  }
  return null;
}

/**
 * Pick the best LinkedIn profile for a person from candidate search results.
 * candidates: [{ url, title }]
 * Returns URL string or null.
 */
async function pickLinkedInWithLlm(personName, companyName, designation, candidates) {
  if (!llmEnabled() || candidates.length === 0) return null;

  const shortlist = candidates.slice(0, 8);
  const list = shortlist
    .map((c, i) => `${i + 1}. ${c.url}\n   title: ${(c.title || '').slice(0, 160)}\n   snippet: ${(c.snippet || '').slice(0, 200)}`)
    .join('\n');

  const rules =
    MODE.verify ||
    `MODE 2 — VERIFYING A SEARCH RESULT
Determine whether any result is THAT SPECIFIC person's LinkedIn profile.
- You may ONLY return a linkedin_url that appears verbatim in the results.
  Never construct, guess, complete, or modify a URL.
- The result must match the same person AND the same employer.
- A parent company, subsidiary, or similarly-named company is NOT a match.
- If no result clearly identifies this person, return an empty people array.`;

  const system = `You are a contact-resolution agent for a company research tool.

${rules}

OUTPUT FORMAT
Respond with ONLY JSON, no prose and no code fences:
{"people": [{"linkedin_url": "<verbatim url from the list>", "evidence": "<exact snippet text>"}]}
Return {"people": []} if there is no confident match.`;

  try {
    const content = await chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Name: ${personName}\nCompany: ${companyName}\nDesignation: ${designation || 'unknown'}\n\nSearch results:\n${list}`,
        },
      ],
      { maxTokens: 300 }
    );

    const parsed = safeJsonParse(content);
    const picked = parsed && Array.isArray(parsed.people) ? parsed.people[0] : null;
    const url = picked && typeof picked.linkedin_url === 'string' ? picked.linkedin_url.trim() : '';
    if (!url) return null;

    // Enforce "verbatim from the results" in code — the model must not have
    // invented or repaired a URL.
    const match = shortlist.find(
      (c) => c.url.toLowerCase().replace(/\/$/, '') === url.toLowerCase().replace(/\/$/, '')
    );
    if (!match) return null;
    if (!/linkedin\.com\/(in|pub)\//i.test(match.url)) return null;
    return match.url;
  } catch (_) {
    return null;
  }
}

module.exports = { llmEnabled, extractLeadersWithLlm, pickLinkedInWithLlm };
