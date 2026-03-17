#!/bin/bash
# =============================================================================
#  SmartShield CyberAware — Auto Deploy Script
#  Applies all bug fixes to your local GitHub repo clone
#  Usage:
#    1. Clone your repo:  git clone https://github.com/meeranpmo-svg/Awareness
#    2. Copy this script into the cloned folder
#    3. Copy the fixed files folder next to this script
#    4. Run:  bash deploy.sh
# =============================================================================

set -e  # Exit on any error

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
success() { echo -e "${GREEN}✅ $1${NC}"; }
warn()    { echo -e "${YELLOW}⚠️  $1${NC}"; }
error()   { echo -e "${RED}❌ $1${NC}"; exit 1; }
header()  { echo -e "\n${BOLD}${BLUE}══════════════════════════════════════════${NC}"; echo -e "${BOLD} $1${NC}"; echo -e "${BOLD}${BLUE}══════════════════════════════════════════${NC}"; }

# ── Config ────────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/meeranpmo-svg/Awareness"
BRANCH="main"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXED_DIR="$SCRIPT_DIR/fixed"   # Folder containing the fixed files

# ── Pre-flight checks ─────────────────────────────────────────────────────────
header "SmartShield CyberAware — Deploy Script"
info "Script directory: $SCRIPT_DIR"

# Check git is installed
command -v git >/dev/null 2>&1 || error "git is not installed. Please install git first."

# Check if we're inside a git repo OR need to clone
if [ ! -d "$SCRIPT_DIR/.git" ]; then
  warn "No git repository found in current directory."
  echo ""
  read -p "  Clone the repo here? (y/n): " CLONE_CONFIRM
  if [[ "$CLONE_CONFIRM" == "y" || "$CLONE_CONFIRM" == "Y" ]]; then
    info "Cloning $REPO_URL ..."
    git clone "$REPO_URL" "$SCRIPT_DIR/repo_clone"
    REPO_DIR="$SCRIPT_DIR/repo_clone"
  else
    error "Please run this script from inside your cloned Awareness repository."
  fi
else
  REPO_DIR="$SCRIPT_DIR"
fi

# Check fixed files directory exists
if [ ! -d "$FIXED_DIR" ]; then
  error "Fixed files folder not found at: $FIXED_DIR\nPlease place the 'fixed' folder (from Claude) next to this script."
fi

# ── Backup ────────────────────────────────────────────────────────────────────
header "Creating Backup"
BACKUP_DIR="$SCRIPT_DIR/backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Backup existing files that will be replaced
for file in \
  index.html \
  admin/dashboard.html admin/modules.html admin/phishing.html \
  admin/users.html admin/reports.html admin/settings.html \
  admin/azure.html admin/compliance.html admin/quizzes.html \
  employee/dashboard.html employee/learn.html employee/quiz.html \
  employee/phishing.html employee/profile.html employee/training.html \
  employee/assessments.html \
  assets/js/data.js assets/js/auth.js assets/js/utils.js assets/js/graph.js; do
  SRC="$REPO_DIR/$file"
  if [ -f "$SRC" ]; then
    DEST_DIR="$BACKUP_DIR/$(dirname $file)"
    mkdir -p "$DEST_DIR"
    cp "$SRC" "$DEST_DIR/"
  fi
done
success "Backup created at: $BACKUP_DIR"

# ── Apply Fixes ───────────────────────────────────────────────────────────────
header "Applying Fixed Files"

FIXED_FILES=(
  # JS Core Files
  "assets/js/data.js:Fixed getOrgOverallScore, email notifications, overdue auto-update, PR-AC-6 control"
  "assets/js/auth.js:Fixed redirectAfterLogin for GitHub Pages, employee login alerts"
  "assets/js/utils.js:Fixed buildSidebar null guards, formatDate/daysAgo invalid date handling"
  "assets/js/graph.js:Fixed /Awarness/ typo in redirectUri (SSO was broken)"

  # Root
  "index.html:Verified graph.js loading order"

  # Admin Pages
  "admin/dashboard.html:Fixed native alert() -> proper notification panel"
  "admin/modules.html:Added auto-enroll + email notification on new module"
  "admin/phishing.html:Added campaign email sending + Azure warning when not configured"
  "admin/users.html:Added duplicate check, password validation, welcome email, reactivate toggle, Azure sync fix"
  "admin/reports.html:Improved export to generate JSON + CSV employee report"
  "admin/azure.html:Fixed all /Awarness/ typo instances"
  "admin/settings.html:Verified redirect URI detection"
  "admin/compliance.html:Copied as-is"
  "admin/quizzes.html:Copied as-is"

  # Employee Pages
  "employee/dashboard.html:Fixed native alert() -> proper notification panel"
  "employee/quiz.html:Fixed native confirm() -> showConfirm(), added certificate email, added graph.js"
  "employee/learn.html:Added certificate email for quiz-less modules, added graph.js"
  "employee/phishing.html:Copied as-is"
  "employee/profile.html:Copied as-is"
  "employee/training.html:Copied as-is"
  "employee/assessments.html:Copied as-is"
)

APPLIED=0
SKIPPED=0
FAILED=0

for entry in "${FIXED_FILES[@]}"; do
  FILE="${entry%%:*}"
  DESC="${entry#*:}"
  SRC="$FIXED_DIR/$FILE"
  DEST="$REPO_DIR/$FILE"
  DEST_DIR="$(dirname $DEST)"

  if [ -f "$SRC" ]; then
    mkdir -p "$DEST_DIR"
    cp "$SRC" "$DEST"
    success "$FILE"
    echo "     → $DESC"
    ((APPLIED++))
  else
    warn "SKIPPED (not in fixed folder): $FILE"
    ((SKIPPED++))
  fi
done

# ── Git Commit ────────────────────────────────────────────────────────────────
header "Committing Changes"
cd "$REPO_DIR"

# Check for unstaged changes
if git diff --quiet && git diff --staged --quiet; then
  warn "No changes detected by git. Files may already be up to date."
else
  git add -A

  COMMIT_MSG="fix: Apply SmartShield CyberAware bug fixes and enhancements

Bug Fixes:
- Fix /Awarness/ typo in graph.js breaking Microsoft 365 SSO redirect
- Add missing getOrgOverallScore() that was crashing admin dashboard
- Fix redirectAfterLogin() for GitHub Pages path compatibility
- Fix invalid CST control PR-AC-6 -> PR-PT-3 in module m7
- Replace native alert()/confirm() with custom UI dialogs
- Fix deactivateUser to support reactivation toggle
- Fix Azure AD sync progress callback mismatch
- Add duplicate email check and password validation in user creation
- Fix daysAgo/formatDate to handle invalid/future dates gracefully
- Add debounce to rebuildOrgCompliance() for performance
- Add auto overdue status update in getUserEnrollments()

New Features:
- Welcome email sent when admin adds new employee
- Phishing simulation emails sent when campaign launched
- Email notification when employee enrolled in new module
- Certificate email auto-sent when employee passes quiz
- Auto-enroll employees when new module published
- Improved export report: JSON summary + CSV employee data
- Notification dropdown panel for alerts (replaces native alert)
- Employee login activity tracked as admin alerts"

  git commit -m "$COMMIT_MSG"
  success "Changes committed"
fi

# ── Push ──────────────────────────────────────────────────────────────────────
header "Pushing to GitHub"
echo ""
read -p "  Push to origin/$BRANCH now? (y/n): " PUSH_CONFIRM

if [[ "$PUSH_CONFIRM" == "y" || "$PUSH_CONFIRM" == "Y" ]]; then
  git push origin "$BRANCH"
  success "Pushed to $REPO_URL"
  echo ""
  echo -e "${BOLD}🌐 Live site will update in ~60 seconds:${NC}"
  echo -e "   https://meeranpmo-svg.github.io/Awareness"
else
  warn "Push skipped. Run manually: git push origin $BRANCH"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
header "Deploy Summary"
echo -e "  ${GREEN}✅ Applied:  $APPLIED files${NC}"
echo -e "  ${YELLOW}⏭️  Skipped:  $SKIPPED files${NC}"
echo -e "  ${BLUE}📦 Backup:   $BACKUP_DIR${NC}"
echo ""
echo -e "${BOLD}Next Steps:${NC}"
echo "  1. Visit https://meeranpmo-svg.github.io/Awareness"
echo "  2. Go to Admin → Settings → Microsoft 365"
echo "  3. Enter your Azure Client ID + Tenant ID to enable:"
echo "     • Microsoft SSO login"
echo "     • Welcome emails for new users"
echo "     • Phishing campaign emails"
echo "     • Certificate emails on quiz pass"
echo ""
success "Deploy complete!"
