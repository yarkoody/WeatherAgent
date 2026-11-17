# User guide

How to use the Weather Risk Intelligence Agent, with prompts to try. Live app: https://weather-risk-agent-e60g.onrender.com. On Render's free plan, the first request after 15 idle minutes takes about a minute while the server wakes up. The live demo allows 10 chat questions a minute per person and 300 a day in total; the map, scores and what-if have their own, looser limit of 120 requests a minute. If you hit the per-minute limit, wait a moment and press Try again.

The app has two tabs. **Ask** is the chat. **Scores** is the full table and map, with no AI involved.

## Ask: the chat

Type a question, or press the mic and speak (Chrome and Edge). Enter sends, even while you dictate. While the agent works, "Analysis steps" shows each tool it calls. The answer arrives once, after every number in it has been checked against the scoring data. Below the answer, charts and tables are drawn straight from the tool outputs, never from the model's text.

### Live voice (Chrome and Edge)

Press **Live** next to the mic to talk hands-free. Allow the microphone when the browser asks. The bar above the box shows what it is doing:
- **Listening:** ask your question. The words it hears appear as you speak, and it sends the question when you pause.
- **Thinking:** the agent runs its tools and checks every figure, as for a typed question.
- **Speaking:** it reads the checked answer aloud. Start talking to interrupt it with a new question, or press **Skip**.

Press **End live** to stop. A session ends by itself after 10 minutes. An answer whose numbers couldn't be verified isn't read aloud; the voice says so, and the answer is on screen. In other browsers the Live button explains that it needs Chrome or Edge.

### What to ask

**Rank hubs**
- `Which hubs in the Midwest are most exposed to winter disruption?` gives a ranking chart of every Midwest hub.
- `Where should we prioritize investment?` gives the top 5 by review priority, the bad-year top 3, and an offer to rank per $1M.
- `Which hubs have the worst bad year?` ranks by lost days in the worst 1 year in 20.

**Compare hubs**
- `Compare Miami and Houston in terms of hurricane and flood exposure.` gives a comparison table with Hurricane and Flood columns.
- `Compare Minneapolis, Chicago, Detroit, Kansas City and Newark` gives one row per hub. The line above the table names the most exposed hub and the hub to examine first.

**Explain one hub**
- `What drives Minneapolis's risk?` gives a breakdown by hazard, the typical and bad year, people served, and **See the math**.
- `Why is the Dallas hub's weather disruption risk high?` corrects the premise when the data disagrees (Dallas is medium) and names the real drivers.
- `How exposed is New York?` answers for Newark, the hub in the New York metro, and says so.

**Weather history**
- `What percentage of days in Denver last year had snowfall?` gives one number for 2025 from hub-point observations.
- `What was the worst winter year in Chicago?` gives a year-by-year chart for 2015 to 2025.
- `When does winter disruption peak in Minneapolis?` gives monthly bars, useful for staffing and preparation timing.

**People**
- `Which hub serves the most people?` ranks metro population. This is a proxy for the people a hub serves, not its customers.
- `Where would a bad year affect the most people?` ranks people-days: people served × lost days.

**Costs and what-if**
- `Rank by priority per million dollars: Minneapolis 3M, Chicago 5M, Newark 4M` gives a per-$1M table. The costs are your inputs, labeled as such.
- `If winter mattered half as much, how would the ranking change?` re-ranks review priority with your weights. A hub that moved shows "▲ from 4" or "▼ from 2", its rank with the default weights. The code works out who moved, and the answer names only those hubs.
- `What would the upgrades cost, and which upgrades fit each hub's risks?` names the upgrade types for each hub's risks and says that costs aren't in the data. It never invents a price.

**Live alerts**
- `Are there any active weather alerts for Chicago?` checks the National Weather Service now. Alerts are operational notices and never change a score.

**Current news (web search)**
- `Is there news this week of a storm or fog closing the Port of Houston?` searches the web. The answer starts with "From the web:", and the sources are listed as links labeled "From the web, not from our scoring data".
- `Search the web for how much rain Houston got in its last major flood, and compare it with its flood exposure.` keeps the two apart: the web figure links to its source, and the exposure comes from the scoring data.
- Scores, rankings, history and NWS alerts never come from the web. Ask `What is Houston's hurricane exposure?` and it uses the data tools only.

**About the system**
- `How is the score calculated?` and `How accurate is this system?` answer from what the system actually does, without invented accuracy rates.

### What it won't do, on purpose
- **Hazards outside the data**, such as earthquake or drought: it says "I don't have that data".
- **Extreme heat and wildfire** are not modeled. Heat rarely closes a hub for whole days (it slows crews and shifts hours), and FEMA's county wildfire figure is mostly wildland far from a metro-core site. So Phoenix and Los Angeles score low on the four modeled hazards only, and the agent says so when it names the safest hubs.
- **Upgrade costs, ROI or a budget split:** it asks for your per-hub costs instead.
- **Forecasts or climate trends:** 11 years of observations are too few.
- **Questions outside hub weather risk:** it says so briefly and suggests what it can answer.

## Reading the results

- **Typical year** is the expected lost operating days a year. **Bad year** is the average of the worst 1 year in 20, which is where hurricanes show up (Miami is first by bad year).
- **Exposure score** (0-100) is typical-year days ÷ 25 × 100. Medium starts at 35 (8.75 days) and high at 60 (15 days).
- **Review priority** (0-100) decides which hubs to examine first. It is exposure, raised for hubs that serve more people and for areas that recover less well. It is a screening measure, not an investment decision: it has no upgrade costs, effectiveness or existing protection.
- **Hurricane** is shown as the chance of at least one in 10 years, the life of an investment.
- **One-hazard charts** (for example a winter ranking) color each bar by that hazard's own level, the one the answer cites: medium from 2 lost days a year and high from 5 (drawn at scores 8 and 20). Hurricane bars are colored by the 10-year chance.
- **People served** is the metro-area population (Census 2025), a proxy. **People-days** = people served × lost days.
- **"Figures checked"** means every number in the answer matched the exact tool field it cites. A figure tagged **From the web** was checked against the web result it links to, not against our data. **"Unverified"** means a number didn't match even after one retry. Read those answers with care.
- **Figures behind this answer**, **Assumptions** and **Data limits** open under each answer.
- **See the math** (in each hub breakdown) shows that hub's own calculation step by step: each hazard's FEMA events × days per event, the 60/40 blend with observed days, the bad-year split, and the review priority formula. "≈" marks a line whose parts were rounded separately.
- **Methodology** (sidebar) opens the full method document inside the app.

## Scores: the table and map

- **The map** colors each hub by its biggest risk, or by people impact. Click a dot, or the pin on a table row, to open that hub's breakdown and history beside the map. Zoom with the buttons, a pinch, or Ctrl/⌘ + scroll.
- **The table** sorts by any column, with filters by region and exposure level. **How the scores work** explains every column in plain language.
- **What if** has sliders for hazard weights and boxes for upgrade costs. The ranking updates as you change them.
- **Export CSV** downloads the table. **Export report** on a hub or an answer opens a print-ready page (save as PDF).

## Settings and developer mode

- **Theme:** light, dark or system.
- **Developer mode** (or `?debug=1`) adds a validation panel to each answer: the grounding result, the tool, field and hub each figure cites, the tool calls with their arguments, latency, tokens, cost and a trace id.
- **Chats** are saved in this browser only. Use New chat to start fresh.
