# Website assets

The icons and illustrations under `public/images/` were exported from the
owner-supplied Figma design:
https://www.figma.com/design/YOS5PGSv8jLwTurzKRE1di/Untitled?node-id=39-2

Prefixes identify the source screen: Home 106:153, dashboard 39:528, network
39:722, details 39:863, battery 39:320 and glossary 39:969. Voltage/current/power/
temperature icons and artwork come from the matching guide design contexts
6:2 / 6:102 / 6:204 / 6:416, visually checked against their V2 versions
39:3 / 39:111 / 39:213 / 39:425. Supplied SVG geometry remains unchanged.
The large header avatar is the 48×48 PNG export of the V2 header's
`avatar-container` instance (I112:389;3876:4512), supplied locally as
`/home/voc/avatar-container.png`. The compact header retains the design's M avatar.
The supplied dashboard battery SVG also represents the header's selected-device
battery; both labels bind to the same observation.

`public/fonts/Quicksand.ttf` and `OFL.txt` originate from the official Google Fonts
repository, `ofl/quicksand/Quicksand[wght].ttf` and `ofl/quicksand/OFL.txt`:
https://github.com/google/fonts/tree/main/ofl/quicksand
The font is bundled locally under the SIL Open Font License included beside it.

The water tank, device case, battery blocks, power equation and illustrative map
are ordinary HTML/CSS matching the supplied design's geometric layout. No Figma
screen capture is used as a UI asset, and the website needs no Figma URLs at runtime.
