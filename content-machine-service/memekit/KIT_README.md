# Peak Meme Creation Kit — 25 templates, 5 outputs

Input a token address or DEX Screener URL, its verified narrative and exact logo. Randomly select five different templates, write five different jokes together, then produce five separate token-specific images.

The quality target is the approved Pumptober pack and revised TOBEY pack from this conversation: recognizable original characters, polished custom scenes, short degen captions and five distinct emotional beats. Merely placing a ticker on five generic memes is insufficient.

Start with `CREATION_GUIDE.md`, then use `prompts/MASTER_CREATION_PROMPT.txt`. `COST_AND_EFFICIENCY.md` explains the recommended cost controls. `template_bank.json` describes every template, layout, emotion, source and file hash. The actual 25 reference pictures are in `templates/`; `Template_Contact_Sheet.jpg` shows the complete bank.

The ten additions are Bernie Once Again, Anakin/Padmé, Gru’s Plan, Waiting Skeleton, Trade Offer, Woman Yelling at Cat, Expanding Brain, Clown Applying Makeup, Roll Safe and Hide the Pain Harold. These are widely used classics; no universal crypto-audience ranking is claimed.

Files for implementation:

- `prompts/`: complete creation, pack planning, targeted review and image-render instructions.
- `schemas/`: token brief and five-meme storyboard JSON Schemas.
- `examples/`: approved captions, historical token briefs and exact prompts used for the five successful revised TOBEY renders. These explain the output standard; they do not guarantee identical regenerations.
- `config/`: quality presets, budget defaults and dated API price assumptions.
- `tools/`: offline template selector, input validator, cost estimator and package verifier. They make no paid API calls.
- `SOURCES.md`: reference-image and cost-documentation provenance.

This is a handoff kit, not an already deployed generator. It includes source assets and instructions rather than copies of the previously generated final images. No API credentials are included or needed to inspect it.

Offline commands, after extracting and changing into this folder:

```sh
python3 tools/verify_package.py
python3 tools/select_templates.py --seed demo --output selected.json
python3 tools/validate_inputs.py examples/tobey_token_brief.json
python3 tools/estimate_cost.py --preset quality --extra-attempts 1
```

Production selection should omit `--seed`; seed is for reproducible debugging. The estimator reports stated assumptions, not an actual invoice. Pillow is only needed to rebuild a contact sheet; the included tools use Python’s standard library.
