// Plugin EMOJIS : guide de réactions curé + choix CONTEXTUEL d'une réaction (pas de random).
// Le bot réagit en se basant sur le message, l'historique du membre et la conversation du groupe.
// Guide volontairement restreint à des emojis CLAIRS et POSITIFS (communauté pro) — on écarte les
// emojis ironiques/ambigus de 2026 (💀 🗿 🫠 🫨 🥲) qui peuvent vexer ou être mal compris.
const { chat } = require('./llm')

// emoji — QUAND l'utiliser (signification en contexte de réaction, communauté UniPods METI AI).
const REACTION_GUIDE = `👍 — acknowledge / agree / "got it, noted"
🙏 — thanks, gratitude, or a heartfelt "please/appreciated"
🙌 — shared celebration, praise, "well done everyone"
👏 — congratulations / applause for a real achievement
🎉 — celebrating a milestone, a launch, a win, or welcoming someone
🔥 — genuinely impressive work or result
💯 — strong agreement, "exactly", top quality
✅ — done / correct / confirmed
💪 — encouragement, "you've got this", rewarding effort
🚀 — progress, shipping, ambitious momentum
🤝 — welcome, agreement, teaming up, partnership
👋 — greeting or welcoming a newcomer
🙂 — light, warm, friendly acknowledgement
😄 — friendly and cheerful, a lighthearted message
😂 — the message is genuinely funny
🤩 — excitement about something cool
💡 — a good idea or a useful insight
📌 — an important point worth remembering
🎯 — spot on, nailed the goal
✨ — a nice touch, polish, positive energy
❤️ — warm community appreciation (use sparingly, never romantic)`

// Choisit UNE réaction adaptée (ou '' pour ne pas réagir). Contexte = message + histo membre + histo groupe.
async function pickReaction(message, ctx = {}) {
  const sys = `You pick ONE emoji to REACT to a WhatsApp message in a friendly but PROFESSIONAL community (the UniPods METI AI programme). React ONLY when an emoji genuinely fits and adds warmth; otherwise output exactly NONE.
Use this reaction guide (emoji — when to use it):
${REACTION_GUIDE}
Rules:
- Output ONLY a single emoji from the guide, or the word NONE. Nothing else.
- Base the choice on the MESSAGE plus the member's recent messages and the group conversation (e.g. celebrate a win they announced, thank a helper, welcome a newcomer, encourage someone who's struggling, applaud a milestone).
- NEVER use ambiguous, ironic, sarcastic, mocking, romantic or potentially offensive emojis.
- When nothing clearly fits, or the message is neutral/administrative/a plain question, output NONE. It is better to not react than to react oddly.`
  const usr = `${ctx.groupHist ? 'GROUP CONVERSATION (recent, for context):\n' + ctx.groupHist + '\n\n' : ''}${ctx.userHist ? "THIS MEMBER'S RECENT MESSAGES: " + ctx.userHist + '\n\n' : ''}MESSAGE TO REACT TO: "${(message || '').slice(0, 300)}"\n\nReply with one emoji from the guide, or NONE.`
  try {
    const r = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { max_tokens: 6, priority: 'low' })
    const e = (r || '').trim()
    if (!e || /none/i.test(e) || /[a-z]{2}/i.test(e)) return '' // NONE ou du texte -> pas de réaction
    return e
  } catch { return '' }
}

module.exports = { pickReaction, REACTION_GUIDE }
