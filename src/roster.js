// Authority registry: who counts as an admin/official in the community.
// In live groups WhatsApp hides phone numbers (@lid), so we rely on the display name
// (pushName) and on whether the message comes from the Announcements group.
//
// Admin identities are provided via environment variables so no personal data is hardcoded:
//   ADMIN_NAMES   - comma-separated display names (case-insensitive match)
//   ADMIN_NUMBERS - comma-separated phone numbers (digits only), for historical data
//                   where the number is visible.
const ADMIN_NAMES = (process.env.ADMIN_NAMES || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '')
  .split(',').map((s) => s.replace(/[^0-9]/g, '')).filter(Boolean)

// Returns 'admin' | 'member' based on the author and context.
function roleOf(entry) {
  if (entry.isAnnouncement) return 'admin' // Announcements group = official
  const name = (entry.senderName || '').toLowerCase().trim()
  if (name && ADMIN_NAMES.some((a) => name === a || name.includes(a))) return 'admin'
  const num = (entry.senderNumber || '').replace(/[^0-9]/g, '')
  if (num && ADMIN_NUMBERS.includes(num)) return 'admin'
  return 'member'
}

module.exports = { roleOf, ADMIN_NAMES, ADMIN_NUMBERS }
