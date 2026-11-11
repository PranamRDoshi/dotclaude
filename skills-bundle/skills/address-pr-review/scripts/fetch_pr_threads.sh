#!/usr/bin/env bash
# Fetch PR review threads as clean JSON for the address-pr-review skill.
# Why a script: the GraphQL query for review threads (with the databaseId needed
# to post threaded replies, plus resolve/outdated state and line anchors) is
# fiddly and error-prone to hand-write on every invocation. Emit it once, right.
#
# Usage: fetch_pr_threads.sh <owner> <repo> <pr-number> [--all]
#   Default: only UNRESOLVED threads (the ones needing action).
#   --all  : include resolved threads too.
#
# Output (stdout): JSON array of threads:
#   [{ threadId, isResolved, isOutdated, path, line,
#      rootCommentDbId,            # numeric id for `in_reply_to` when replying
#      comments: [{ author, body, dbId }] }]
#
# Requires: gh (authenticated), jq. Cross-platform (macOS bash 3 + Linux).
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <owner> <repo> <pr-number> [--all]" >&2
  exit 2
fi

owner="$1"; repo="$2"; pr="$3"; mode="${4:-}"

query='query($owner:String!,$repo:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:50, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line
          comments(first:50){
            nodes{ databaseId body author{ login } }
          }
        }
      }
    }
  }
}'

# Paginate through all threads, concatenating node arrays.
cursor="null"
all_nodes="[]"
while : ; do
  if [ "$cursor" = "null" ]; then
    page=$(gh api graphql -f query="$query" -F owner="$owner" -F repo="$repo" -F pr="$pr")
  else
    page=$(gh api graphql -f query="$query" -F owner="$owner" -F repo="$repo" -F pr="$pr" -F cursor="$cursor")
  fi
  nodes=$(echo "$page" | jq '.data.repository.pullRequest.reviewThreads.nodes')
  all_nodes=$(jq -n --argjson a "$all_nodes" --argjson b "$nodes" '$a + $b')
  has_next=$(echo "$page" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
  if [ "$has_next" != "true" ]; then break; fi
  cursor=$(echo "$page" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
done

# Reshape into the documented output; filter to unresolved unless --all.
filter='map(select(.isResolved == false))'
[ "$mode" = "--all" ] && filter='.'

echo "$all_nodes" | jq "
  $filter
  | map({
      threadId: .id,
      isResolved: .isResolved,
      isOutdated: .isOutdated,
      path: .path,
      line: .line,
      rootCommentDbId: (.comments.nodes[0].databaseId // null),
      comments: [ .comments.nodes[] | { author: .author.login, body: .body, dbId: .databaseId } ]
    })
"
