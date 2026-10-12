# token-meter

After every prompt, a line under the chat box:

    Last ≈ 25k tok ($0.31) · session $4.80 · context 41% · 5h 22% · week 9% · cache warm 52m

- Last: cost-weighted tokens of your last prompt (helpers included) and its $ cost
- session: total cost so far
- context: how full the context window is; at 60% a hint suggests /caveman, at 80% a warning suggests /handoff
- 5h / week: plan usage windows (subscription only)
- cache: minutes until the prompt cache goes cold (re-reading the whole chat costs more after that)

Commands: `/token-meter` (full breakdown), `/token-meter off`, `/token-meter on`, `/token-meter ttl 5|60` (cache lifetime in minutes, default 60).

Figures the host does not provide are left out. Mods are early access; the API may change between releases.
