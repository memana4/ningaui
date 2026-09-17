# The mascot

## The name

A **kowari** (*Dasyuroides byrnei*) is a small carnivorous marsupial from the stony deserts
of south-western Queensland and north-eastern South Australia. It is about 15 cm of body
with another 13 cm of tail, it hunts at night, and its tail carries a black brush-like
crest — the feature you can draw in three strokes and still recognise.

It suits the project for a mundane reason as well as a charming one: it is a forager. It
goes out, brings things back, and what ends up in the burrow is what it decided to carry.
That is the whole design of this harness — the agent proposes, and nothing lands until you
take it.

Alternatives considered and rejected: *numbat* (a direct collision with Perplexity's agent
monitoring tool), *tenrec*, *dormouse*, *quoll*, *pika* (all taken on npm or PyPI),
*olinguito* and *dunnart* (both free, both fine, both less distinctive).

## The drawing

One shape list, two outputs. [`assets/mascot.py`](../assets/mascot.py) holds the geometry
and emits:

- `assets/kowari-icon.svg` — vector, for humans and browsers
- `assets/kowari-{16,32,48,128,512}.png` — for the README and the repositories
- `platform/{chrome,firefox}/icons/icon-{16,32,48,128}.png` — what the manifests point at

```bash
python3 assets/mascot.py
```

Pillow rasterizes at 8× and downsamples, so the small sizes are honest: a mascot that only
looks right at 512 px is not a mascot.

The blue harness and the leash leaving the top of the frame are the project's argument in
one image. The animal is equipped and it can go and do things — you are holding the other
end.

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
