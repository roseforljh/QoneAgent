# Third-party notices

## pi-web-access

The SSRF address classification and manual redirect validation in `apps/agent-runtime/src/web-fetch-security.ts` are adapted from [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access), revision `f50da6e440f6a53f85c3b8087f4da45dc9c63c7b`. The upstream project is licensed under the MIT License. Copyright (c) 2025 Nico Bailon.

## Runtime dependencies

`defuddle`, `linkedom`, `turndown`, `undici`, and `proxy-from-env` are used under their respective MIT licenses. Defuddle is used with `useAsync: false`, so its optional third-party extraction fallback is disabled.
