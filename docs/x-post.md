# Room 402 social posts

Replace the placeholders before posting. X shortens every link to 23 characters, so the X counts below treat `<REPO_URL>` as 23 characters. Once you paste a real link, the count stays the same.

## X post, main version

```text
I built Room 402, an escape room for AI agents. The room is a CreateOS sandbox and the only way out is code the agent writes. Every hint sits behind an HTTP 402, paid from a $5 Stripe test-mode hold. Time costs too. @createosai @stripe #buildinpublic <REPO_URL>
```

Character count: 274 (251 characters of text plus 23 for the link). Counted literally with the placeholder text, it is 261.

## X post, alternate

```text
Room 402 is an escape room for AI agents. Each one gets a CreateOS sandbox and $5 on a Stripe test-mode hold. Hints are HTTP 402 invoices. Wrong doors cost $0.50, each minute $0.05. Stripe captures what the agent spent. @createosai @stripe #buildinpublic <REPO_URL>
```

Character count: 278 (255 characters of text plus 23 for the link). Counted literally with the placeholder text, it is 265. This one has 2 characters of room, so don't add anything to it.

## LinkedIn

194 words, placeholders included.

```text
I built Room 402 for the Build Agents That Run Code hackathon by @CreateOS and Stripe Projects. It's an escape room for AI agents.

The room is a real Linux microVM in a CreateOS sandbox, and the only way out is code the agent writes and runs. One puzzle is a loop that would take 31 million years unless the agent rewrites it as a matrix power. One vault is impossible on purpose. Walking away from it early earns a flag.

Every hint sits behind a real HTTP 402 and gets paid from a $5 @Stripe test-mode hold. Time costs $0.05 a minute and wrong doors cost $0.50. Past $1 the agent has to ask a human for approval. At the end Stripe captures what the agent spent and releases the rest.

I ran Claude Haiku 5.5 against GPT-6 Luna. <RESULT>

What didn't work: Stripe's Machine Payments Protocol. The 402 challenge worked, but payment never settled on my India account. RBI rules require 3DS on every card payment, and Shared Payment Tokens can't run off-session. So I wrote my own 402 plus an off-session hold and partial capture.

Demo: <VIDEO_URL>
Code: <REPO_URL>
Live: <DEPLOYED_URL>
```

`<RESULT>` should be one or two sentences from the real runs, for example which model escaped, what each one spent, and which flags it earned. Leave it out until those numbers exist.
