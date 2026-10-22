# QA report: <task>, iteration <N>

**Verdict: PASS | FAIL** (<n> BLOCKER, <n> MAJOR, <n> MINOR)

Build: branch <branch> @ <commit>, address <address>.

## Findings

### F-1 · BLOCKER | MAJOR | MINOR · <in short, what is broken>
Device: <preset>, <orientation>, DPR <2–3>, <online | offline>. Criterion <number>.
Steps:
1. <action>
2. <action>
Expected: <what should have happened>.
Actual: <what happened; console message or exception, if any>.
Screenshot: [<caption>](shots/<file>.png)<, storyboard: [sheet](shots/<folder>/)>.

## Criteria

| # | Result | Finding |
|---|---|---|
| 1 | ✅ | — |
| 2 | ❌ | F-1 |

## Checked by hand

<n> devices (<list>), <n> screens; gestures: <n> taps, <n> swipes
(fast and slow); offline — <n> times; storyboards — <n>.

## Console and network (summary)

- Console: <errors and warnings, or "clean">.
- Exceptions: <list or "none">.
- Failed requests: <list or "none">.
