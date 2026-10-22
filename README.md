# pi-exoscale

[Pi](https://pi.dev/) extension that registers Exoscale as a model provider.
After you install it, Exoscale zones appear in `/login`, and their models
appear in `/model`. You do not add provider or model entries to `models.json`.

## Install

```sh
git clone https://github.com/exoscale/pi-exoscale ~/path/to/pi-exoscale
pi install ~/path/to/pi-exoscale
```

`pi install` writes the path to `~/.pi/agent/settings.json`. Restart Pi.

To try the extension without installing it, pass it on the command line:

```sh
pi --extension ~/path/to/pi-exoscale
```

The extension has no runtime dependencies. Pi loads the TypeScript file
directly and supplies the `@earendil-works/pi-ai` modules.

## Sign in

Run `/login`, choose **API key**, then choose **Exoscale `<zone>`**. Pi asks
for two values:

1. The Exoscale AI API key for that zone. Exoscale AI API keys are zone-local,
   so each zone stores its own key in `~/.pi/agent/auth.json`.
2. Optional Dedicated Inference endpoints in that zone, comma-separated. Pi
   stores them with the key. Enter nothing for on-demand inference only.

Pi discovers models for every endpoint of the zone and lists them in
`/model` as `<provider>/<model-id>`, for example
`exo-de-fra-1/nvidia/Qwen3.8-27B-NVFP4`.

Note: the Pi login dialog shows the key while you type it instead of
masking it. When others can see your screen, export `EXOSCALE_AI_API_KEY`
instead and skip `/login`.

## Environment variables

The `EXOSCALE_AI_` prefix marks these variables as Exoscale AI settings. The
Exoscale IAM API key is a different credential, and this extension does not
read it.

| Variable | Effect |
| --- | --- |
| `EXOSCALE_AI_API_KEY` | AI API key for the default zone `de-fra-1`. Works before you run `/login`, so a fresh install needs no interactive step. |
| `EXOSCALE_AI_ENDPOINT` | Extra endpoint for the default zone, in addition to the on-demand endpoint. |
| `EXOSCALE_AI_ZONES` | Comma-separated zones added to the zone list, for example `EXOSCALE_AI_ZONES=de-muc-1`. |
| `EXOSCALE_AI_ENDPOINTS` | Written by `/login` into the stored credential. Lists the Dedicated Inference endpoints of that zone. Set it by hand only if you edit `auth.json`. |
| `PI_OFFLINE` | When set, the extension skips the zone list and model discovery, and uses the cached model list. |

Exoscale AI API keys are zone-local, so `EXOSCALE_AI_API_KEY` applies only to
`de-fra-1`. Sign in to other zones with `/login`.

## Behavior

- One provider per zone: `exo-<zone>`, shown as **Exoscale `<zone>`**. The
  zone list comes from `https://api-ch-gva-2.exoscale.com/v2/zone`. When that
  request fails, the default zone and `EXOSCALE_AI_ZONES` still register.
- The on-demand endpoint of a zone is
  `https://inference.<zone>.exoscale-cloud.com/v1`. Dedicated Inference
  endpoints of the same zone share the zone's provider.
- Models come from `GET {endpoint}/models` with the zone's key. The
  extension reads `max_model_len` and `max_completion_tokens` when the
  endpoint reports them, and otherwise uses a 262144 token context and a
  32768 token output limit. The output limit is never larger than the
  context window.
- A failed endpoint keeps the models it reported before, so one broken
  endpoint does not remove the models of the other endpoints. `/exo` prints
  the errors.
- When two endpoints of a zone serve the same model id, the extension keeps
  the first entry plain and prefixes the later ones, for example
  `abc12def/nvidia/Model` for a Dedicated Inference deployment.
- The extension writes the last good model list of each zone to
  `~/.pi/agent/pi-exoscale-models.json`. Startup reads that file, so a
  single-shot `pi -p` run works offline and before discovery finishes.
- At startup, with a zone key available and no cache, the extension reads
  `~/.pi/agent/auth.json` to find the key of its own providers and runs
  discovery once. Pi resolves `--provider` and `--model` before it hands a
  credential to a provider, so without this step the first `pi -p` run after
  a login would report an unknown provider. The extension uses each key only
  against its own zone endpoints and never prints it.

## Status command

`/exo` lists every registered Exoscale zone, its endpoints, the model count,
whether a key is configured, and the last discovery errors:

```
/exo
/exo refresh      # force a refresh of all Exoscale model lists
```

Example, printed in a session with one signed-in zone:

```
de-fra-1: 3 models, stored credential
  https://inference.de-fra-1.exoscale-cloud.com/v1
ch-gva-2: 0 models, not connected
  https://inference.ch-gva-2.exoscale-cloud.com/v1
```

## Use a model

```sh
pi --list-models exoscale
pi -p "hello" --provider exo-de-fra-1 --model nvidia/Qwen3.8-27B-NVFP4
```

## Development

```sh
npm install     # development dependencies for typecheck only
npm test
npm run typecheck
```
