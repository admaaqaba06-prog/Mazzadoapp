# Data Sources & Integrations Needed
Nothing below is connected yet for the agents. Each line says exactly what Karam (or the team) needs to provide.

| # | Source | Needed for | What to provide (step-by-step friendly) | Who | Priority |
|---|---|---|---|---|---|
| 1 | Git repository | All CTO work | Open Claude Code inside the repo folder on your machine (`cd mazzado && claude`) | Karam | P0 |
| 2 | Firestore (read-only) | Funnel, auctions, unit economics | Weekly export of collections (auctions, bids, users count, memberships, orders) as JSON/CSV, with personal fields removed → ops/data/. Or a read-only script the CTO agent writes and you run. Never give agents a production admin key. | Karam / CTO | P0 |
| 3 | Payment ledger | Paid winners, completion | Yazan's weekly ops report + payment confirmations (anonymized: auction id, amount, date, status) → ops/data/ | Yazan | P0 |
| 4 | Meta Ads Manager | CAC, ROAS, creative tests | Export (CSV) from BOTH portfolios' accounts: campaign/ad set/ad level, daily, with spend, impressions, link clicks, results by event. Or install a Meta Ads MCP connector in Claude Code later. | Karam | P0 |
| 5 | Meta Events Manager | Tracking validation | Screenshot/export of events received, event match quality, domain verification status for mazzado.com | Karam | P0 |
| 6 | GA4 (if installed) | Visitors, funnel | GA4 property access or monthly CSV export of funnel exploration | Karam | P1 |
| 7 | CliQ API (BAE / Staq) | Automatic payment verification | Bank must enable the API product subscription causing the 403s. Ask BAE BaaS team which product/scope to activate on your client. | Karam → BAE | P1 |
| 8 | WhatsApp (channel + notifications) | Buyer activation, re-engagement | Channel follower count weekly; notification delivery stats if the provider exposes them | Karam | P2 |
| 9 | Seller pipeline | Supply metrics | Simple sheet from Hamoudeh/Yousef: merchant, date contacted, items offered, listed (Y/N), outcome | Sourcing team | P1 |
| 10 | Social analytics (IG/FB/TikTok) | Organic content performance | Weekly insights export | Karam | P2 |
| 11 | Costs | Unit economics | Delivery cost per order, payment fees, any sourcing costs, team cost allocation | Yazan | P0 |

## Connectors noted
Your claude.ai account has Slack, Gmail, Google Drive, Shopify, Klaviyo and others connected. Whether those show up inside Claude Code depends on how you sign in and your version — run `/mcp` inside Claude Code to see what is actually available there. Nothing on that list gives Meta Ads, GA4 or Firestore access, so until a connector for those is added, agents work from exports in ops/data/.
