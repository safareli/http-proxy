// Simple script to trigger a Telegram GraphQL approval request through the proxy.
// Usage: bun trigger-gql-approval.ts
//
// Make sure the proxy is running first (bun index.ts).

const FAKE_TOKEN =
  "github_pat_XXXXXXXXXXXXXXXXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const res = await fetch("https://127.0.0.1:443/graphql", {
  method: "POST",
  headers: {
    Host: "api.github.com",
    Authorization: `Bearer ${FAKE_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    query: `mutation CreatePR($input: CreatePullRequestInput!) {
      createPullRequest(input: $input) {
        pullRequest { id url }
      }
      addComment(input: {subjectId: "issue123", body: "hello"}) {
        commentEdge { node { id body } }
      }
      likeComment(input: {subjectId: "issue123", body: "hello"}) {
        commentEdge { node { id body } }
      }
    }`,
    variables: {
      input: {
        repositoryId: "abc123",
        title: "My PR",
        body: "Description here",
        baseRefName: "main",
        headRefName: "feature-branch",
      },
    },
  }),
  tls: { rejectUnauthorized: false },
});

console.log(`Status: ${res.status}`);
console.log(`Body: ${await res.text()}`);
