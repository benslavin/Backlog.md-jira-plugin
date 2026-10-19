#!/bin/bash
# Print the CHANGELOG.md section for a version, as GitHub release notes
# Usage: scripts/release-notes.sh <version>   (0.3.5 or v0.3.5)
# Run from the project root. Fails when CHANGELOG.md has no such section.
set -euo pipefail

version="${1:?usage: $0 <version>}"
version="${version#v}"

notes=$(awk -v v="$version" '
	index($0, "## [" v "]") == 1 { found = 1; next }
	found && /^## \[/ { exit }
	found && /^\[[^]]+\]: / { exit }
	found { print }
' CHANGELOG.md | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')

if [ -z "$notes" ]; then
	echo "No CHANGELOG.md section for $version" >&2
	exit 1
fi

printf '%s\n\n**Full changelog:** [CHANGELOG.md](https://github.com/benslavin/Backlog.md-jira-plugin/blob/v%s/CHANGELOG.md)\n' "$notes" "$version"
