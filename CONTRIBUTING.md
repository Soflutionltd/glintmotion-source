# Contributing to Glintmotion

Contributions are welcome: bug fixes, speed, new agent tools, studio improvements and
translations of the interface. For effects and transitions, contribute to
[Glintmotion Effects](https://github.com/Soflutionltd/glintmotion-effects) instead.

## Before you start

Open an [issue](https://github.com/Soflutionltd/glintmotion/issues) for anything larger than a
small fix, so we can agree on the approach before you spend time on it. Bugs need your macOS
version and the Glintmotion version shown in **À propos** (About).

## Running the app from source

You need a Mac with Apple Silicon, Node.js 22 or later and Bun.

```sh
bun install
bun run build          # the engine, once and after each change under packages/
cd apps/desktop
npm install
npm start
```

## Checks

Run these before opening a pull request, and say in it what you ran:

```sh
cd apps/desktop && node --test *.test.mjs   # the app
bun run test                                # the engine and the studio
npx oxlint <the files you changed>
```

A change you can see needs a screenshot or a short recording in the pull request. A change
that claims to be faster needs the timings before and after, on the same Mac.

## Pull requests

- One logical change per pull request.
- Commit messages follow `type(scope): description`, for example
  `fix(desktop): keep the playhead when the studio reloads`.
- No secrets, tokens or personal data in code, fixtures or screenshots.

## Rights in your contribution

By opening a pull request you confirm that you wrote the contribution or have the right to
submit it, and you grant Soflution Ltd a perpetual, worldwide, non-exclusive, royalty-free,
irrevocable license to use, copy, modify, distribute, sublicense and use commercially your
contribution, as part of this repository or separately. Your contribution is published in this
repository under the terms of [LICENSE.md](LICENSE.md). Third-party code you include keeps its
own license.
