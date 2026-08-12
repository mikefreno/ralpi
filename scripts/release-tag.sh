#!/bin/bash

# release-tag.sh — version bump, commit, tag, and push for this pi extension.
#
# Mirrors the release flow from PodTui's scripts/release-tag.sh, adapted for
# the pi extension repos: the version lives in package.json, and the omp port
# derives its version from it during regeneration.
#
# Usage:
#   scripts/release-tag.sh            interactive release
#   scripts/release-tag.sh --dry-run  plan the bump/tag/pushes without doing
#
# After this script runs:
#   - pushing master triggers the port-to-omp workflow, which regenerates and
#     pushes the omp port (picking up the new version)
#   - pushing the v* tag triggers the publish workflow, which npm-publishes
#     this package and its omp port together

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DRY_RUN=0
for arg in "$@"; do
	case "$arg" in
	--dry-run) DRY_RUN=1 ;;
	-h | --help)
		echo "usage: $0 [--dry-run]"
		exit 0
		;;
	esac
done

if [ ! -d .git ] && [ ! -f .git ]; then
	echo -e "${RED}✗ not a git repository: $PROJECT_ROOT${NC}"
	exit 1
fi

if ! git diff-index --quiet HEAD --; then
	echo -e "${RED}✗ working tree is dirty — commit or stash before releasing${NC}"
	git status --short
	exit 1
fi

NAME=$(python3 -c "import json;print(json.load(open('package.json'))['name'])")
OMP_NAME=$(python3 -c "import json,re;n=json.load(open('package.json'))['name'];print(re.sub(r'^@mikefreno/(.+)$', r'@mikefreno/omp-\1', n))")
CURRENT_VERSION=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")

echo -e "${CYAN}Package:${NC} ${GREEN}${NAME}${NC}"
echo -e "${CYAN}Current version:${NC} ${GREEN}v${CURRENT_VERSION}${NC}"
echo ""

IFS='.' read -r MAJOR MINOR PATCH <<<"$CURRENT_VERSION"
MAJOR=$(echo "$MAJOR" | sed 's/[^0-9].*//')
MINOR=$(echo "$MINOR" | sed 's/[^0-9].*//')
PATCH=$(echo "$PATCH" | sed 's/[^0-9].*//')

echo -e "${CYAN}Select version bump type:${NC}"
echo "  1) Major (breaking changes)     ${MAJOR}.${MINOR}.${PATCH} → $((MAJOR + 1)).0.0"
echo "  2) Minor (new features)         ${MAJOR}.${MINOR}.${PATCH} → ${MAJOR}.$((MINOR + 1)).0"
echo "  3) Patch (bug fixes)            ${MAJOR}.${MINOR}.${PATCH} → ${MAJOR}.${MINOR}.$((PATCH + 1))"
echo "  4) Custom version"
echo "  5) Cancel"
echo ""
read -p "Enter choice (1-5): " -n 1 -r CHOICE
echo ""
echo ""

case $CHOICE in
1) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
2) NEW_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
3) NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
4)
	read -p "Enter new version (e.g. 0.6.1): " -r NEW_VERSION
	echo ""
	;;
5)
	echo -e "${YELLOW}Cancelled.${NC}"
	exit 0
	;;
*)
	echo -e "${RED}✗ invalid choice${NC}"
	exit 1
	;;
esac

if ! echo "$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
	echo -e "${RED}✗ version must be MAJOR.MINOR.PATCH (got: ${NEW_VERSION})${NC}"
	exit 1
fi

if git rev-parse -q --verify "refs/tags/v${NEW_VERSION}" >/dev/null; then
	echo -e "${RED}✗ tag v${NEW_VERSION} already exists${NC}"
	exit 1
fi

echo -e "${CYAN}New version:${NC} ${GREEN}v${NEW_VERSION}${NC}"
echo ""
echo -e "${YELLOW}This will:${NC}"
echo "  1. Set package.json → \"version\": \"${NEW_VERSION}\""
echo "  2. Commit the bump"
echo "  3. Create annotated tag v${NEW_VERSION}"
echo "  4. Push master and the tag to every remote"
REMOTES=$(git remote)
for r in $REMOTES; do
	echo "       → $r"
done
echo ""
echo -e "${YELLOW}Note: master push triggers the port-to-omp workflow; the v* tag${NC}"
echo -e "push triggers the npm publish workflow (this package + omp port).${NC}"
echo ""
read -p "Proceed? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
	echo -e "${YELLOW}Aborted.${NC}"
	exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
	echo -e "${BLUE}── dry run: no changes made ──${NC}"
	exit 0
fi

# ── Apply the bump ───────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[1/4]${NC} Updating package.json..."
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"${NEW_VERSION}\"/" package.json
rm -f package.json.bak
echo -e "${GREEN}✓ package.json updated${NC}"

if git diff --quiet -- package.json; then
	echo -e "${RED}✗ package.json did not change${NC}"
	exit 1
fi

echo -e "${CYAN}[2/4]${NC} Committing..."
git add package.json
git commit -m "chore: bump version to v${NEW_VERSION}"
echo -e "${GREEN}✓ committed${NC}"

echo -e "${CYAN}[3/4]${NC} Tagging..."
git tag -a "v${NEW_VERSION}" -m "${NAME} v${NEW_VERSION}"
echo -e "${GREEN}✓ tagged v${NEW_VERSION}${NC}"
echo ""

echo -e "${CYAN}[4/4]${NC} Pushing..."
FAILED=""
for r in $REMOTES; do
	echo -e "  → ${BLUE}${r}${NC} master..."
	if git push "$r" master >/dev/null 2>&1; then
		echo -e "    ${GREEN}✓ master pushed${NC}"
	else
		echo -e "    ${RED}✗ master push failed${NC}"
		FAILED="$FAILED $r"
		continue
	fi
	echo -e "  → ${BLUE}${r}${NC} v${NEW_VERSION}..."
	if git push "$r" "v${NEW_VERSION}" >/dev/null 2>&1; then
		echo -e "    ${GREEN}✓ tag pushed${NC}"
	else
		echo -e "    ${RED}✗ tag push failed${NC}"
		FAILED="$FAILED $r"
	fi
done

echo ""
if [ -n "$FAILED" ]; then
	echo -e "${RED}✗ push failed for remote(s):${FAILED}${NC}"
	echo -e "${YELLOW}Re-run: git push <remote> master && git push <remote> v${NEW_VERSION}${NC}"
	exit 1
fi

echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}✓ ${NAME} v${NEW_VERSION} released${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}Version:${NC} ${CURRENT_VERSION} → ${GREEN}${NEW_VERSION}${NC}"
echo -e "${CYAN}Tag:${NC} v${NEW_VERSION}"
echo ""
echo -e "${BLUE}Next steps (automatic, nothing to do):${NC}"
echo "  1. Gitea Actions port-to-omp regenerates and pushes the omp port"
echo "     (which now carries version ${NEW_VERSION})"
echo "  2. Gitea Actions publish npm-publishes ${NAME} and"
echo "     ${OMP_NAME} to the npm registry"
echo ""
echo -e "${CYAN}Local port (optional):${NC} run 'bun port-to-omp.mjs' in this repo, or"
echo "pull in ~/.omp once CI has pushed."
