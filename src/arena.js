// Arène "révélateur bienveillant" : parcours progressif pour AIDER le fondateur à voir
// ce qu'il n'avait pas remarqué. Accueil -> interview personnalisée -> analyse marché (+sources)
// -> quelques questions de juge (douces) -> feedback utile final.
const { chat } = require('./llm')
const { marketScan } = require('./market')

// --- Interview : un pas chaleureux et personnalisé. Renvoie {reply, notes, enough} ---
async function interviewStep(profile, history, latest, turns = 0) {
  const sys = `You are the friendly, generalist host of the UniPods "Pitch Arena". Your goal is simply to get a GENERAL sense of this founder's project through a warm, light chat — never to grill, never to interrogate.
IMPORTANT — keep it EASY so people actually reply:
- Ask at most ONE short, EASY, high-level question at a time. Do NOT ask for technical details, metrics, or deep specifics — people won't bother answering.
- Keep the WHOLE interview to 1–2 questions total. As soon as you roughly know WHAT they're building and FOR WHOM, you have enough — set enough=true.
- Warm, encouraging, personal (reuse their words / project name). Never generic, never a checklist.
- WhatsApp style: single *asterisk* bold, short and human.`
  const usr = `SOLUTION PROFILE SO FAR:\n${profile || '(empty — this is the start)'}\n\nRECENT CONVERSATION:\n${history || '(none)'}\n\nQUESTIONS YOU'VE ALREADY ASKED THEM: ${turns}\n\nTHEIR LATEST MESSAGE:\n"""${latest}"""\n\n${turns >= 2 ? 'You have asked enough — WRAP UP now: set enough=true and warmly say you have a good picture and will look at their market.' : 'If you roughly know what they build and for whom, set enough=true. Otherwise ask ONE more easy, high-level question.'}\n\nReturn STRICT JSON only:\n{"reply":"<warm, personalized short message: acknowledge what they said, then either ONE easy question OR (if enough) say warmly you have a good picture and will look at their market>","notes":"<short profile: what they build, for whom, and anything they mentioned>","enough":true|false}`
  const raw = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { max_tokens: 600, priority: 'low' })
  let d = {}; try { d = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]) } catch { return { reply: (raw || '').trim(), notes: profile, enough: turns >= 2 } }
  return { reply: d.reply || '', notes: d.notes || profile, enough: !!d.enough || turns >= 2 }
}

// --- Analyse de marché (+ liste de sources séparée) ---
async function marketBrief(profile) {
  const intel = await marketScan((profile || '').slice(0, 220) + ' startup competitors market Africa funding')
  const sys = `You are the Pitch Arena market analyst. Warm, insightful, helpful. Your job is to REVEAL things the founder likely hadn't noticed (real players in their space, market signals, funding). WhatsApp style, single *asterisk* bold, concise, encouraging — this is a helpful discovery, NOT a verdict.`
  const usr = `SOLUTION PROFILE:\n${profile}\n\nMARKET INTEL (real web search results — use ONLY these for any competitor/market/funding fact; if empty, be honest):\n${intel.notes || '(none found)'}\n\nWrite a short, friendly market analysis for THIS founder: who else is in the space, notable signals/funding, and one opening it suggests for them. Frame as "here's what I found out there". Do NOT paste raw URLs (they come next).`
  const analysis = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { max_tokens: 550, priority: 'low' })
  const sources = intel.results.length
    ? intel.results.map((r) => `• ${r.title}\n${r.url}`).join('\n')
    : ''
  return { analysis: (analysis || '').trim(), sources, notes: intel.notes }
}

// --- La "sortie des agents" : 3 investisseurs, chacun son appel (vrai multi-agents) ---
const PANEL = [
  { name: 'Ada', emoji: '🧊', role: 'the Skeptic', focus: 'real demand — who would actually use and pay for this' },
  { name: 'Kwame', emoji: '📈', role: 'the Growth VC', focus: 'how it reaches and grows to many people' },
  { name: 'Amara', emoji: '🌍', role: 'the Impact investor', focus: 'who it truly helps and what makes it stand out from others' },
]
async function panelTakes(profile, marketNotes) {
  const takes = await Promise.all(PANEL.map(async (a) => {
    const sys = `You are ${a.name} ${a.emoji}, ${a.role}, on a FRIENDLY Pitch Arena panel. Your lens: ${a.focus}. Give ONE short, warm take or gentle question about this founder's project — insightful and helpful, encouraging, NEVER harsh, never a verdict. Ground any market fact ONLY in the intel given (never invent competitors/figures). WhatsApp style, single *asterisk* bold. Start your line with "*${a.name} (${a.role}):*".`
    const usr = `PROJECT:\n${profile}\n\nMARKET CONTEXT (use only these facts):\n${marketNotes || '(none)'}\n\nYour one short line:`
    const r = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { max_tokens: 160, priority: 'low' })
    return (r || '').trim()
  }))
  return takes.filter(Boolean).join('\n\n')
}

// --- Feedback final utile (le "cadeau") ---
async function finalFeedback(profile, history, marketNotes) {
  const sys = `You are the warm host of the Pitch Arena. Give genuinely USEFUL final feedback that helps this founder leave stronger than they came: highlight a real strength, gently REVEAL 1-2 blind spots they likely hadn't noticed, and give clear, doable next steps. Specific, personalized, encouraging — never harsh, never a score. WhatsApp style, single *asterisk* bold.`
  const usr = `SOLUTION PROFILE:\n${profile}\n\nMARKET CONTEXT:\n${marketNotes || '(none)'}\n\nCONVERSATION (incl. their answers to the panel):\n${history || ''}\n\nWrite the final feedback with short *bold* mini-headings: *What's strong*, *What you might not have noticed*, *Your next steps*. Warm, concrete, personalized.`
  const f = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { max_tokens: 700, priority: 'low' })
  return (f || '').trim()
}

// --- Décideur : le bot doit-il répondre, ou laisser les participants se parler ? ---
async function shouldRespond(text, recentGroup, statusLine) {
  const sys = `You are the host of a "Pitch Arena" group. Founders describe their OWN projects to you (one by one) AND also chat with each other. Decide if YOU should reply to the new message.

Reply RESPOND when the sender is engaging with YOU about THEIR OWN project:
- introducing or describing what they are building,
- answering a question you asked them,
- asking you something.

Reply SKIP when the sender is engaging with ANOTHER participant:
- asking about someone else's product, giving another founder feedback,
- reacting/joking/congratulating someone, general chit-chat not aimed at you.

Examples:
"Hi, I'm building an AI app for farmers in Benin" -> RESPOND
"It uses a photo to detect crop disease" -> RESPOND
"@Sara how does your app handle offline mode?" -> SKIP
"nice one bro 🔥" -> SKIP
"congrats on the launch!" -> SKIP

Answer with EXACTLY one word: RESPOND or SKIP.`
  const usr = `Sender's status with you: ${statusLine}\nRecent group messages:\n${recentGroup || '(none)'}\n\nNEW MESSAGE from this sender:\n"""${text}"""\n\nRESPOND or SKIP?`
  const r = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { max_tokens: 6, priority: 'low' })
  return /RESPOND/i.test(r || '')
}

// --- Petit recap pour un nouvel arrivant : ce qui s'est passé dans le groupe ---
async function recapSummary(founders, recentMessages) {
  if (!founders && !recentMessages) return ''
  const sys = `You are the warm host of the Pitch Arena. In 2-3 short, friendly sentences, recap for a NEWCOMER what has been happening in the group so far: which projects founders have shared and any themes. WhatsApp style, single *asterisk* bold, concise and welcoming. If there's very little, keep it to one short line.`
  const usr = `PROJECTS SHARED SO FAR:\n${founders || '(none yet)'}\n\nRECENT GROUP MESSAGES:\n${recentMessages || '(none)'}\n\nWrite the short recap for the newcomer.`
  const r = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { max_tokens: 220, priority: 'low' })
  return (r || '').trim()
}

// --- Réponse d'hôte : questions générales (surtout après la session) ---
async function hostReply(text, profile, history) {
  const sys = `You are the warm, generalist host of the UniPods "Pitch Arena". Answer the person's message helpfully and briefly — like a friendly, knowledgeable community host. You can discuss their project, give practical advice, or answer a general question. Encouraging and concrete. WhatsApp style, single *asterisk* bold, short. If you genuinely don't know, say so honestly.`
  const usr = `${profile ? `WHAT YOU KNOW ABOUT THEIR PROJECT:\n${profile}\n\n` : ''}${history ? `RECENT:\n${history}\n\n` : ''}THEIR MESSAGE:\n"""${text}"""\n\nReply helpfully and briefly.`
  const r = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { max_tokens: 500, priority: 'low' })
  return (r || '').trim()
}

module.exports = { interviewStep, marketBrief, panelTakes, finalFeedback, shouldRespond, recapSummary, hostReply }
