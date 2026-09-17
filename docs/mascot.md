# The mascot

## The name

A **ningaui** (*Ningaui* spp., three described species) is one of the smallest carnivorous
marsupials alive: 5–10 grams, huge dark eyes, a pointed snout, active at night across the
arid interior of Australia. It hunts insects alone, and it does not need an audience.

It fits the project: small, capable, out at night, working country that would kill a larger
animal. The harness is the rest of the idea — it does the work, you hold the other end, and
you can drop the leash when it has earned that.

## Why not kowari

The project was briefly called **kowari** and the name was changed on the strength of the
collision check, not taste:

| candidate | GitHub | npm | verdict |
|---|---|---|---|
| **ningaui** | 2 repos, top ★7 and untouched since 2023 | free | chosen — nothing active or large |
| **kultarr** | 2 repos, top ★2 pushed a month ago | free | viable, but recently active |
| **kowari** | 12 repos, including a **Rust vector database** pushed in late 2025 | free | rejected: active and adjacent |
| **dunnart** | 18 repos, one ★146 (dead since 2016), one ★18 pushed 2026 | free | rejected: active small tool |
| **olinguito** | 22 repos, the biggest all dead since 2015–2016 | free | runner-up, just longer |
| numbat, tenrec, dormouse, quoll, pika, chevrotain, tarsier, marmot, jerboa | — | taken | rejected |
| gundi, suslik | 150 and 171 repos | free | rejected: crowded |

## The drawing

One shape list, two outputs. [`assets/mascot.py`](../assets/mascot.py) holds the geometry
and emits:

- `assets/ningaui-icon.svg` — vector, for humans and browsers
- `assets/ningaui-{16,32,48,128,512}.png` — for the README and the repositories
- `platform/{chrome,firefox}/icons/icon-{16,32,48,128}.png` — what the manifests point at

```bash
python3 assets/mascot.py
```

Pillow rasterizes at 8× and downsamples, so the small sizes are honest.

The blue harness and the leash leaving the top of the frame are the project's argument in
one image: the animal is equipped and free to work, and someone is still holding the leash
until it has earned the right to be let go.

## Colour

| role | value |
|---|---|
| fur | `#E0B041` |
| fur, shaded (ear, foot) | `#C9973A` |
| belly, inner ear, paw | `#F6E3B8` |
| crest, nose, eye | `#2B2018` |
| harness and leash | `#4E9BD1`, edge `#2C6B96` |
| tile | `#141A1F`, edge `#243039` |

The tile colour matches the panel's background, so the icon and the interface look like one
thing.
