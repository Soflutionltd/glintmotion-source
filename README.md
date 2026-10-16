<p align="center">
  <a href="https://github.com/Soflutionltd/glintmotion">
    <img src="https://raw.githubusercontent.com/Soflutionltd/glintmotion/main/assets/banner.webp" alt="Glintmotion: the motion design studio your AI agent can drive" width="100%">
  </a>
</p>

<p align="center">
  <a href="https://github.com/Soflutionltd/glintmotion/releases/latest">Download</a> ·
  <a href="https://github.com/Soflutionltd/glintmotion">Home page</a> ·
  <a href="https://github.com/Soflutionltd/glintmotion-effects">Effects library</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="LICENSE.md">Licence</a>
</p>

# Glintmotion source

This is the source of Glintmotion, the native macOS motion design studio your AI agent can
drive. To use the app, download it from the [home page](https://github.com/Soflutionltd/glintmotion):
it is signed, notarized and updates itself.

## What is in this repository

| Folder          | What it is                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/desktop/` | The macOS app: home screen, studio window, local MCP server and agent tools, renders, delivery, updates |
| `packages/`     | The render engine, the studio, the CLI and the lint and motion checks                                   |
| `skills/`       | The agent skills the app installs for Cursor and Claude Code                                            |
| `registry/`     | The catalog of blocks and components                                                                    |

## Run it from source

You need a Mac with Apple Silicon, Node.js 22 or later and Bun.

```sh
bun install
bun run build
cd apps/desktop
npm install
npm start
```

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), then open a pull request.
Report bugs on the [home page's issues](https://github.com/Soflutionltd/glintmotion/issues), and
security problems as described in [SECURITY.md](SECURITY.md).

## Licence

Free to read, run and change for personal and non-commercial use, under
[PolyForm Noncommercial 1.0.0](LICENSES/PolyForm-Noncommercial-1.0.0.md). Commercial use needs a
licence from Soflution Ltd. Some files keep the licence they came with: [LICENSE.md](LICENSE.md)
says which.

<p align="center"><sub>© 2026 Soflution Ltd</sub></p>
