# Contributing

Thank you for your interest in **AI Agent Office**. This project is released under the [MIT License](LICENSE).

## Issues: welcome

Bug reports, feature ideas and requests for new agents are welcome as issues. Please never paste conversation content, prompts, tokens or private paths into an issue.

## Character sets and room packs: welcome

You can generate or draw your own character sets using the prompts and recipes in [docs/customizing.md](docs/customizing.md), or submit character and room packs:

1. Follow the formats in [docs/packs.md](docs/packs.md) and the schemas in `schemas/`. Put a character pack in `packs/characters/<id>/` and a room pack in `packs/rooms/<id>/`.
2. Declare one of these licences in `manifest.json`: `CC0-1.0`, `CC-BY-4.0` or `MIT`.
3. Submit only your own original work, and set `"original_work": true`. Packs that imitate existing game characters or brands are not accepted.
4. Use only PNG images, JSON and Tiled map files, and Markdown or text notes, with each file at most 8 MiB and no symbolic links.
5. Sign off every commit (`git commit -s`), certifying the [Developer Certificate of Origin](https://developercertificate.org/): you made the work, or have the right to submit it under the declared licence.

Every pack is checked automatically, then reviewed by hand before it is bundled.

## Code contributions

The public repository is generated from the maintainers' primary repository, so please open an issue to discuss bugs or features before sending code changes.
