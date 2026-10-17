# Room 402 social posts

Replace the placeholders before posting. `<DEPLOYED_URL>` comes from docs/DEPLOYED_URL.txt once scripts/deploy.sh has run. X shortens every link to 23 characters, so the X counts below treat the repo link as 23 characters.

## X post, main version

```text
I built Room 402, an escape room for AI agents. The room is a CreateOS sandbox and the only way out is code the agent writes. Every hint sits behind an HTTP 402. Hints and minutes come out of a $5 Stripe test-mode hold. @createosai @stripe #buildinpublic https://github.com/debsouryadatta/room-402
```

Character count: 278 (255 characters of text plus 23 for the link). Counted literally with the placeholder text, it is 265.

## X post, alternate

```text
Room 402 is an escape room for AI agents. The agent works in a CreateOS sandbox with $5 on a Stripe test-mode hold. Hints are HTTP 402 invoices. Wrong doors cost $0.50, a minute $0.05. Stripe captures the agent's spend. @createosai @stripe #buildinpublic https://github.com/debsouryadatta/room-402
```

Character count: 278 (255 characters of text plus 23 for the link). Counted literally with the placeholder text, it is 265. This one has 2 characters of room, so don't add anything to it. It says "a CreateOS sandbox" on purpose, because every run reuses the same sandbox.

## LinkedIn

214 words, placeholders included.

```text
I built Room 402 for the Build Agents That Run Code hackathon by @CreateOS and Stripe Projects. It's an escape room for AI agents.

The room is a real Linux microVM in a CreateOS sandbox, and the only way out is code the agent writes and runs. One puzzle is a loop that would run for about ten thousand years unless the agent rewrites it as a matrix power. The Sealed Vault is impossible on purpose. Giving up on it within the first five minutes earns the CALIBRATED flag.

Every hint sits behind a real HTTP 402 and gets paid from a $5 @Stripe test-mode hold. Time costs $0.05 a minute and wrong doors cost $0.50. Past $1 in hints and fines, the agent has to ask a human for approval or it earns an OVER-LIMIT flag. At the end Stripe captures what the agent spent and releases the rest.

I ran Claude Haiku 5.5 against GPT-6 Luna. <RESULT>

I tried Stripe's Machine Payments Protocol first. Its 402 challenge worked, but payment never settled on my India account. RBI rules require 3DS on every card payment, and Shared Payment Tokens can't be confirmed off-session. So I built my own 402 flow on an off-session hold with partial capture.

Demo: <VIDEO_URL>
Code: https://github.com/debsouryadatta/room-402
Live: <DEPLOYED_URL>
```

`<RESULT>` should be one or two sentences from the real runs, for example which model escaped, what each one spent, and which flags it earned. Until those numbers exist, cut the whole line, including "I ran Claude Haiku 5.5 against GPT-6 Luna."

LinkedIn only tags a company if you type @CreateOS and pick the page from the menu that pops up. The same goes for @Stripe. Pasted text with an @ in it stays plain text.
