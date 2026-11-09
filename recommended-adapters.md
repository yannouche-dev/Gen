# Recommended LTX-2.5 / LTX-2.3 adapters

These Hugging Face repositories provide LoRAs and merges that improve motion consistency, anatomy detail, and specific action fidelity on LTX models. Compatible with the existing LoRA downloader in the Gen agent (`POST /videogen/loras`).

Most work on both LTX-2.3 and LTX-2.5 (LoRAs trained on 2.3 generally transfer). Prefer Image-to-Video for best results.

## High-detail / motion fidelity
- **maximsobolev275/LTX-10Eros-LoRA-r768**

  - Recommended file: `LTX_10Eros_LoRA_fro99-avgrank77.safetensors`
  - Strength: 0.4-0.7
  - Improves overall coherence and detail.

## Multi-action adapter
- **Muapi/dr34ml4y-all-in-one-nsfw-wan-ltx2*** (or community mirrors of DR34ML4Y_LT3X_V3)

  - Strength: 0.3-0.6
  - Covers several positions; use trigger-style keywords in prompts.

## Specific action / finish adapters
- Search Hugging Face for CoachBate or Lora-Daddy LTX repositories (examples: fluid/finish focused LoRAs).

  - Strength: 0.6-1.0
  - Best with Image-to-Video.

## Optional uncensored base merges
If you prefer a community merge instead of the official weights:
- ChrisColeTech/LTX-2.3-uncensored-v1.4-FP8
- frtertaer/LTX-2.5-uncensored-v1.1-FP8

**Note:** Official Lightricks/LTX-2.5 still requires accepting the license on the model page with the account linked to your HF token.

To load a LoRA in the Gen interface: use the LoRA section and provide the Hugging Face repo + path. The agent downloads it automatically.
