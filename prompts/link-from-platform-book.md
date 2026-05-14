# Linking a GroveDB proof from the platform book to the visualizer

You're an agent helping with the [dashpay/platform](https://github.com/dashpay/platform) book or codebase. When you encounter a GroveDB proof — in book prose, a Rust test, or bench stderr — produce a direct link to the live visualizer at **https://dashpay.github.io/grovedb-proof-visualizer-widget/** and add it next to the proof so readers can open it in one click.

The visualizer auto-loads from the URL fragment. Nothing leaves the user's browser; the fragment is never sent to GitHub Pages.

## URL shape

```
https://dashpay.github.io/grovedb-proof-visualizer-widget/#f=<format>&d=<data>
```

- `<format>` — one of:
  - `text` — the human-readable `GroveDBProof::Display` dump (starts with `GroveDBProofV0 {` or `GroveDBProofV1 {`)
  - `bytes` — the bincode-encoded proof as a hex string (what `cargo bench` and `Drive::execute_*` return). **Hex-decode to raw bytes before encoding** — see below.
  - `json` — the renderer's `ProofView` IR JSON (only relevant if you've already run `cargo run -p grovedb-proof-view --example dump_proof`)
- `<data>` — `gzip(input)` then base64url-encoded (no padding, `+` → `-`, `/` → `_`)

## Encoding (Python, works on any platform shell)

For the `text` and `json` formats — the input is already a string:

```bash
python3 -c "import sys,base64,gzip; sys.stdout.write(base64.urlsafe_b64encode(gzip.compress(sys.stdin.buffer.read())).rstrip(b'=').decode())" < proof.txt
```

For the `bytes` format — hex-decode FIRST so we compress the raw 40 KB proof, not its 80 KB hex form:

```bash
python3 -c "import sys,base64,gzip; data=bytes.fromhex(sys.stdin.read().strip()); sys.stdout.write(base64.urlsafe_b64encode(gzip.compress(data)).rstrip(b'=').decode())" < proof.hex
```

The output of either command is the `<data>` part of the URL. Concatenate with the prefix above and you have the share link.

## Where proofs live in the platform repo

| Location | Format | Notes |
|---|---|---|
| `book/src/drive/count-index-examples.md` | `text` | Inside `<details>` blocks as ` ```text ` fenced code |
| `cargo bench --bench document_count_worst_case` stderr (lines prefixed `[proof]`) | `text` (under `proof-display:`) and `bytes` (under `bytes:`) | The bench's `display_proofs()` produces both for every Query 1–7 fixture |
| `Drive::execute_document_count_request`, `GroveDb::prove_query`, etc. | `bytes` (raw `Vec<u8>`) | If you're embedding a fresh proof, hex-encode the bytes first |
| Anything that calls `format!("{}", proof)` on a decoded `GroveDBProof` | `text` | Same Display impl as the book uses |

## Inserting the link in the book

For an existing `<details>` block, hoist the link into the `<summary>`:

```markdown
<details>
<summary>Expand to see the structured proof (5 layers) — or <a href="https://dashpay.github.io/grovedb-proof-visualizer-widget/#f=text&d=ENCODED_HERE">open interactively in the visualizer ↗</a></summary>

```text
GroveDBProofV1 {
  ...
}
```

</details>
```

For inline references in prose, drop a one-liner directly above or below the proof block:

```markdown
**[▶ Visualize this proof interactively](https://dashpay.github.io/grovedb-proof-visualizer-widget/#f=text&d=ENCODED_HERE)**
```

Use `▶` (U+25B6) as the affordance — it's already the project's convention for "interactive thing here."

## Worked example

Given this snippet from [count-index-examples.md Query 1](https://github.com/dashpay/platform/blob/v3.1-dev/book/src/drive/count-index-examples.md):

```text
GroveDBProofV1 {
  LayerProof {
    proof: Merk(
      0: Push(Hash(HASH[bd29...]))
      ...
    )
  }
}
```

1. Save the proof to `/tmp/proof.txt`
2. `python3 -c "import sys,base64,gzip; sys.stdout.write(base64.urlsafe_b64encode(gzip.compress(sys.stdin.buffer.read())).rstrip(b'=').decode())" < /tmp/proof.txt > /tmp/encoded`
3. Build the URL: `echo "https://dashpay.github.io/grovedb-proof-visualizer-widget/#f=text&d=$(cat /tmp/encoded)"`
4. Insert the link in the markdown above the `<details>` block.

## Size guidance

- Tier 1 (preferred — works everywhere): URL ≤ **20 KB** (most query-result proofs fit here).
- Tier 2 (fine in browsers, but Slack/Discord may truncate the link surface): **20–50 KB**. The visualizer warns the user when they generate a link this big.
- Tier 3 (Safari may refuse): > **50 KB**. For these:
  - Prefer linking to the `bytes` form (hex-decoded → raw → gzip is the most compact path).
  - If still too large, generate the smaller `ProofView` JSON via `cargo run -p grovedb-proof-view --example dump_proof -- <hex>` and use `f=json`.
  - Last resort: skip the share link and just instruct the reader to paste the proof into the playground manually.

## Don't

- Don't URL-encode the `<data>` — base64url is already URL-safe. Adding `%XX` escapes will break decoding.
- Don't put the data in a query string (`?d=…`). The fragment (`#…`) is what keeps the proof out of the GitHub Pages access logs.
- Don't strip whitespace from `text`-format input before compressing — the parser tolerates it, but reproducible encoding helps if anyone re-derives the link.
- Don't include the `0x` prefix on hex input for `bytes` format. Just the hex digits.

## Sanity check

After encoding, paste the URL into a browser and confirm:
- The visualizer loads
- The status line shows "loaded shared `<format>` proof; rendering…"
- The expected number of layers shows up

If decoding fails ("couldn't decode shared link"), the most likely cause is `=` padding wasn't stripped, or you mixed up the format selector.
