import type { ColorValue } from '@orca/platform-contract';

export interface ColorPalette { id: string; name: string; colors: readonly { name: string; value: ColorValue }[] }

// Display swatches from the user-provided ColorDialog reference. RAL values
// are screen approximations, not authoritative physical color measurements.
export const DEFAULT_COLOR_PALETTES: readonly ColorPalette[] = [
  {
    "id": "basic",
    "name": "Basic colors",
    "colors": [
      {
        "name": "Red",
        "value": {
          "kind": "solid",
          "color": "#FF0000"
        }
      },
      {
        "name": "Orange",
        "value": {
          "kind": "solid",
          "color": "#FF8000"
        }
      },
      {
        "name": "Yellow",
        "value": {
          "kind": "solid",
          "color": "#FFFF00"
        }
      },
      {
        "name": "Lime",
        "value": {
          "kind": "solid",
          "color": "#80FF00"
        }
      },
      {
        "name": "Green",
        "value": {
          "kind": "solid",
          "color": "#00FF00"
        }
      },
      {
        "name": "Cyan",
        "value": {
          "kind": "solid",
          "color": "#00FFFF"
        }
      },
      {
        "name": "Blue",
        "value": {
          "kind": "solid",
          "color": "#0000FF"
        }
      },
      {
        "name": "Purple",
        "value": {
          "kind": "solid",
          "color": "#8000FF"
        }
      },
      {
        "name": "Magenta",
        "value": {
          "kind": "solid",
          "color": "#FF00FF"
        }
      },
      {
        "name": "Pink",
        "value": {
          "kind": "solid",
          "color": "#FF8080"
        }
      },
      {
        "name": "Brown",
        "value": {
          "kind": "solid",
          "color": "#804000"
        }
      },
      {
        "name": "Black",
        "value": {
          "kind": "solid",
          "color": "#000000"
        }
      },
      {
        "name": "%90",
        "value": {
          "kind": "solid",
          "color": "#191919"
        }
      },
      {
        "name": "%80",
        "value": {
          "kind": "solid",
          "color": "#333333"
        }
      },
      {
        "name": "%70",
        "value": {
          "kind": "solid",
          "color": "#4C4C4C"
        }
      },
      {
        "name": "%60",
        "value": {
          "kind": "solid",
          "color": "#666666"
        }
      },
      {
        "name": "%50",
        "value": {
          "kind": "solid",
          "color": "#808080"
        }
      },
      {
        "name": "%40",
        "value": {
          "kind": "solid",
          "color": "#999999"
        }
      },
      {
        "name": "%30",
        "value": {
          "kind": "solid",
          "color": "#B3B3B3"
        }
      },
      {
        "name": "%20",
        "value": {
          "kind": "solid",
          "color": "#CCCCCC"
        }
      },
      {
        "name": "%10",
        "value": {
          "kind": "solid",
          "color": "#E6E6E6"
        }
      },
      {
        "name": "White",
        "value": {
          "kind": "solid",
          "color": "#FFFFFF"
        }
      },
      {
        "name": "Red",
        "value": {
          "kind": "solid",
          "color": "#FF0000"
        }
      },
      {
        "name": "Crimson",
        "value": {
          "kind": "solid",
          "color": "#DC143C"
        }
      },
      {
        "name": "Orange red",
        "value": {
          "kind": "solid",
          "color": "#FF4500"
        }
      },
      {
        "name": "Tomato",
        "value": {
          "kind": "solid",
          "color": "#FF6347"
        }
      },
      {
        "name": "Orange",
        "value": {
          "kind": "solid",
          "color": "#FFA500"
        }
      },
      {
        "name": "Dark orange",
        "value": {
          "kind": "solid",
          "color": "#FF8C00"
        }
      },
      {
        "name": "Gold",
        "value": {
          "kind": "solid",
          "color": "#FFD700"
        }
      },
      {
        "name": "Burly wood",
        "value": {
          "kind": "solid",
          "color": "#DEB887"
        }
      },
      {
        "name": "Bisque",
        "value": {
          "kind": "solid",
          "color": "#FFE4C4"
        }
      },
      {
        "name": "Misty rose",
        "value": {
          "kind": "solid",
          "color": "#FFE4E1"
        }
      },
      {
        "name": "Yellow",
        "value": {
          "kind": "solid",
          "color": "#FFFF00"
        }
      },
      {
        "name": "Light yellow",
        "value": {
          "kind": "solid",
          "color": "#FFFFE0"
        }
      },
      {
        "name": "Lemon chiffon",
        "value": {
          "kind": "solid",
          "color": "#FFFACD"
        }
      },
      {
        "name": "Beige",
        "value": {
          "kind": "solid",
          "color": "#F5F5DC"
        }
      },
      {
        "name": "Light golden rod yellow",
        "value": {
          "kind": "solid",
          "color": "#FAFAD2"
        }
      },
      {
        "name": "Pale golden rod",
        "value": {
          "kind": "solid",
          "color": "#EEE8AA"
        }
      },
      {
        "name": "Khaki",
        "value": {
          "kind": "solid",
          "color": "#F0E68C"
        }
      },
      {
        "name": "Dark khaki",
        "value": {
          "kind": "solid",
          "color": "#BDB76B"
        }
      },
      {
        "name": "Peach puff",
        "value": {
          "kind": "solid",
          "color": "#FFDAB9"
        }
      },
      {
        "name": "Moccasin",
        "value": {
          "kind": "solid",
          "color": "#FFE4B5"
        }
      },
      {
        "name": "Papaya whip",
        "value": {
          "kind": "solid",
          "color": "#FFEFD5"
        }
      },
      {
        "name": "Blanched almond",
        "value": {
          "kind": "solid",
          "color": "#FFEBCD"
        }
      },
      {
        "name": "Antique white",
        "value": {
          "kind": "solid",
          "color": "#FAEBD7"
        }
      },
      {
        "name": "Navajo white",
        "value": {
          "kind": "solid",
          "color": "#FFDEAD"
        }
      },
      {
        "name": "Wheat",
        "value": {
          "kind": "solid",
          "color": "#F5DEB3"
        }
      },
      {
        "name": "Golden rod",
        "value": {
          "kind": "solid",
          "color": "#DAA520"
        }
      },
      {
        "name": "Chocolate",
        "value": {
          "kind": "solid",
          "color": "#D2691E"
        }
      },
      {
        "name": "Peru",
        "value": {
          "kind": "solid",
          "color": "#CD853F"
        }
      },
      {
        "name": "Fire brick",
        "value": {
          "kind": "solid",
          "color": "#B22222"
        }
      },
      {
        "name": "Sienna",
        "value": {
          "kind": "solid",
          "color": "#A0522D"
        }
      },
      {
        "name": "Saddle brown",
        "value": {
          "kind": "solid",
          "color": "#8B4513"
        }
      },
      {
        "name": "Brown",
        "value": {
          "kind": "solid",
          "color": "#A52A2A"
        }
      },
      {
        "name": "Rosy brown",
        "value": {
          "kind": "solid",
          "color": "#BC8F8F"
        }
      },
      {
        "name": "Salmon",
        "value": {
          "kind": "solid",
          "color": "#FA8072"
        }
      },
      {
        "name": "Light salmon",
        "value": {
          "kind": "solid",
          "color": "#FFA07A"
        }
      },
      {
        "name": "Dark salmon",
        "value": {
          "kind": "solid",
          "color": "#E9967A"
        }
      },
      {
        "name": "Sandy brown",
        "value": {
          "kind": "solid",
          "color": "#F4A460"
        }
      },
      {
        "name": "Coral",
        "value": {
          "kind": "solid",
          "color": "#FF7F50"
        }
      },
      {
        "name": "Light coral",
        "value": {
          "kind": "solid",
          "color": "#F08080"
        }
      },
      {
        "name": "Indian red",
        "value": {
          "kind": "solid",
          "color": "#CD5C5C"
        }
      },
      {
        "name": "Dark red",
        "value": {
          "kind": "solid",
          "color": "#8B0000"
        }
      },
      {
        "name": "Maroon",
        "value": {
          "kind": "solid",
          "color": "#800000"
        }
      },
      {
        "name": "Green yellow",
        "value": {
          "kind": "solid",
          "color": "#ADFF2F"
        }
      },
      {
        "name": "Yellow green",
        "value": {
          "kind": "solid",
          "color": "#9ACD32"
        }
      },
      {
        "name": "Chartreuse",
        "value": {
          "kind": "solid",
          "color": "#7FFF00"
        }
      },
      {
        "name": "Lawn green",
        "value": {
          "kind": "solid",
          "color": "#7CFC00"
        }
      },
      {
        "name": "Lime green",
        "value": {
          "kind": "solid",
          "color": "#32CD32"
        }
      },
      {
        "name": "Spring green",
        "value": {
          "kind": "solid",
          "color": "#00FF7F"
        }
      },
      {
        "name": "Medium spring green",
        "value": {
          "kind": "solid",
          "color": "#00FA9A"
        }
      },
      {
        "name": "Lime",
        "value": {
          "kind": "solid",
          "color": "#00FF00"
        }
      },
      {
        "name": "Green",
        "value": {
          "kind": "solid",
          "color": "#008000"
        }
      },
      {
        "name": "Forest green",
        "value": {
          "kind": "solid",
          "color": "#228B22"
        }
      },
      {
        "name": "Dark green",
        "value": {
          "kind": "solid",
          "color": "#006400"
        }
      },
      {
        "name": "Olive drab",
        "value": {
          "kind": "solid",
          "color": "#6B8E23"
        }
      },
      {
        "name": "Olive",
        "value": {
          "kind": "solid",
          "color": "#808000"
        }
      },
      {
        "name": "Dark olive green",
        "value": {
          "kind": "solid",
          "color": "#556B2F"
        }
      },
      {
        "name": "Pale green",
        "value": {
          "kind": "solid",
          "color": "#98FB98"
        }
      },
      {
        "name": "Light green",
        "value": {
          "kind": "solid",
          "color": "#90EE90"
        }
      },
      {
        "name": "Medium sea green",
        "value": {
          "kind": "solid",
          "color": "#3CB371"
        }
      },
      {
        "name": "Sea green",
        "value": {
          "kind": "solid",
          "color": "#2E8B57"
        }
      },
      {
        "name": "Dark sea green",
        "value": {
          "kind": "solid",
          "color": "#8FBC8F"
        }
      },
      {
        "name": "Cadet blue",
        "value": {
          "kind": "solid",
          "color": "#5F9EA0"
        }
      },
      {
        "name": "Medium aqua marine",
        "value": {
          "kind": "solid",
          "color": "#66CDAA"
        }
      },
      {
        "name": "Turquoise",
        "value": {
          "kind": "solid",
          "color": "#40E0D0"
        }
      },
      {
        "name": "Medium turquoise",
        "value": {
          "kind": "solid",
          "color": "#48D1CC"
        }
      },
      {
        "name": "Dark turquoise",
        "value": {
          "kind": "solid",
          "color": "#00CED1"
        }
      },
      {
        "name": "Pale turquoise",
        "value": {
          "kind": "solid",
          "color": "#AFEEEE"
        }
      },
      {
        "name": "Aqua",
        "value": {
          "kind": "solid",
          "color": "#00FFFF"
        }
      },
      {
        "name": "Cyan",
        "value": {
          "kind": "solid",
          "color": "#00FFFF"
        }
      },
      {
        "name": "Light cyan",
        "value": {
          "kind": "solid",
          "color": "#E0FFFF"
        }
      },
      {
        "name": "Mint cream",
        "value": {
          "kind": "solid",
          "color": "#F5FFFA"
        }
      },
      {
        "name": "Honey dew",
        "value": {
          "kind": "solid",
          "color": "#F0FFF0"
        }
      },
      {
        "name": "Aquamarine",
        "value": {
          "kind": "solid",
          "color": "#7FFFD4"
        }
      },
      {
        "name": "Light sea green",
        "value": {
          "kind": "solid",
          "color": "#20B2AA"
        }
      },
      {
        "name": "Dark cyan",
        "value": {
          "kind": "solid",
          "color": "#008B8B"
        }
      },
      {
        "name": "Teal",
        "value": {
          "kind": "solid",
          "color": "#008080"
        }
      },
      {
        "name": "Dark slate gray",
        "value": {
          "kind": "solid",
          "color": "#2F4F4F"
        }
      },
      {
        "name": "Light slate gray",
        "value": {
          "kind": "solid",
          "color": "#778899"
        }
      },
      {
        "name": "Slate gray",
        "value": {
          "kind": "solid",
          "color": "#708090"
        }
      },
      {
        "name": "Deep sky blue",
        "value": {
          "kind": "solid",
          "color": "#00BFFF"
        }
      },
      {
        "name": "Dodger Blue",
        "value": {
          "kind": "solid",
          "color": "#1E90FF"
        }
      },
      {
        "name": "Sky blue",
        "value": {
          "kind": "solid",
          "color": "#87CEEB"
        }
      },
      {
        "name": "Light sky blue",
        "value": {
          "kind": "solid",
          "color": "#87CEFA"
        }
      },
      {
        "name": "Light blue",
        "value": {
          "kind": "solid",
          "color": "#ADD8E6"
        }
      },
      {
        "name": "Powder blue",
        "value": {
          "kind": "solid",
          "color": "#B0E0E6"
        }
      },
      {
        "name": "Light steel blue",
        "value": {
          "kind": "solid",
          "color": "#B0C4DE"
        }
      },
      {
        "name": "Steel blue",
        "value": {
          "kind": "solid",
          "color": "#4682B4"
        }
      },
      {
        "name": "Cornflower blue",
        "value": {
          "kind": "solid",
          "color": "#6495ED"
        }
      },
      {
        "name": "Royal blue",
        "value": {
          "kind": "solid",
          "color": "#4169E1"
        }
      },
      {
        "name": "Blue",
        "value": {
          "kind": "solid",
          "color": "#0000FF"
        }
      },
      {
        "name": "Medium blue",
        "value": {
          "kind": "solid",
          "color": "#0000CD"
        }
      },
      {
        "name": "Midnight blue",
        "value": {
          "kind": "solid",
          "color": "#191970"
        }
      },
      {
        "name": "Dark blue",
        "value": {
          "kind": "solid",
          "color": "#00008B"
        }
      },
      {
        "name": "Navy",
        "value": {
          "kind": "solid",
          "color": "#000080"
        }
      },
      {
        "name": "Slate blue",
        "value": {
          "kind": "solid",
          "color": "#6A5ACD"
        }
      },
      {
        "name": "Dark slate blue",
        "value": {
          "kind": "solid",
          "color": "#483D8B"
        }
      },
      {
        "name": "Medium slate blue",
        "value": {
          "kind": "solid",
          "color": "#7B68EE"
        }
      },
      {
        "name": "Blue violet",
        "value": {
          "kind": "solid",
          "color": "#8A2BE2"
        }
      },
      {
        "name": "Indigo",
        "value": {
          "kind": "solid",
          "color": "#4B0082"
        }
      },
      {
        "name": "Dark violet",
        "value": {
          "kind": "solid",
          "color": "#9400D3"
        }
      },
      {
        "name": "Dark orchid",
        "value": {
          "kind": "solid",
          "color": "#9932CC"
        }
      },
      {
        "name": "Medium orchid",
        "value": {
          "kind": "solid",
          "color": "#BA55D3"
        }
      },
      {
        "name": "Orchid",
        "value": {
          "kind": "solid",
          "color": "#DA70D6"
        }
      },
      {
        "name": "Violet",
        "value": {
          "kind": "solid",
          "color": "#EE82EE"
        }
      },
      {
        "name": "Medium purple",
        "value": {
          "kind": "solid",
          "color": "#9370DB"
        }
      },
      {
        "name": "Purple",
        "value": {
          "kind": "solid",
          "color": "#800080"
        }
      },
      {
        "name": "Rebecca purple",
        "value": {
          "kind": "solid",
          "color": "#663399"
        }
      },
      {
        "name": "Medium violet red",
        "value": {
          "kind": "solid",
          "color": "#C71585"
        }
      },
      {
        "name": "PaleV violet red",
        "value": {
          "kind": "solid",
          "color": "#DB7093"
        }
      },
      {
        "name": "Deep pink",
        "value": {
          "kind": "solid",
          "color": "#FF1493"
        }
      },
      {
        "name": "Hot pink",
        "value": {
          "kind": "solid",
          "color": "#FF69B4"
        }
      },
      {
        "name": "Light pink",
        "value": {
          "kind": "solid",
          "color": "#FFB6C1"
        }
      },
      {
        "name": "Pink",
        "value": {
          "kind": "solid",
          "color": "#FFC0CB"
        }
      },
      {
        "name": "Plum",
        "value": {
          "kind": "solid",
          "color": "#DDA0DD"
        }
      },
      {
        "name": "Thistle",
        "value": {
          "kind": "solid",
          "color": "#D8BFD8"
        }
      },
      {
        "name": "Magenta",
        "value": {
          "kind": "solid",
          "color": "#FF00FF"
        }
      },
      {
        "name": "Fuchsia",
        "value": {
          "kind": "solid",
          "color": "#FF00FF"
        }
      },
      {
        "name": "Dark magenta",
        "value": {
          "kind": "solid",
          "color": "#8B008B"
        }
      },
      {
        "name": "Linen",
        "value": {
          "kind": "solid",
          "color": "#FAF0E6"
        }
      },
      {
        "name": "Old lace",
        "value": {
          "kind": "solid",
          "color": "#FDF5E6"
        }
      },
      {
        "name": "Sea shell",
        "value": {
          "kind": "solid",
          "color": "#FFF5EE"
        }
      },
      {
        "name": "Ivory",
        "value": {
          "kind": "solid",
          "color": "#FFFFF0"
        }
      },
      {
        "name": "Floral white",
        "value": {
          "kind": "solid",
          "color": "#FFFAF0"
        }
      },
      {
        "name": "Lavender blush",
        "value": {
          "kind": "solid",
          "color": "#FFF0F5"
        }
      },
      {
        "name": "Ghost white",
        "value": {
          "kind": "solid",
          "color": "#F8F8FF"
        }
      },
      {
        "name": "Alice blue",
        "value": {
          "kind": "solid",
          "color": "#F0F8FF"
        }
      },
      {
        "name": "Lavender",
        "value": {
          "kind": "solid",
          "color": "#E6E6FA"
        }
      },
      {
        "name": "White smoke",
        "value": {
          "kind": "solid",
          "color": "#F5F5F5"
        }
      },
      {
        "name": "Gainsboro",
        "value": {
          "kind": "solid",
          "color": "#DCDCDC"
        }
      }
    ]
  },
  {
    "id": "orca",
    "name": "Orca palette",
    "colors": [
      {
        "name": "Coral fire",
        "value": {
          "kind": "solid",
          "color": "#ED1C24"
        }
      },
      {
        "name": "Sea anemone",
        "value": {
          "kind": "solid",
          "color": "#C41E3A"
        }
      },
      {
        "name": "Deep abyss",
        "value": {
          "kind": "solid",
          "color": "#800000"
        }
      },
      {
        "name": "Lobster red",
        "value": {
          "kind": "solid",
          "color": "#B22222"
        }
      },
      {
        "name": "Sandy clay",
        "value": {
          "kind": "solid",
          "color": "#A0522D"
        }
      },
      {
        "name": "Driftwood",
        "value": {
          "kind": "solid",
          "color": "#8B4513"
        }
      },
      {
        "name": "Sea buckthorn",
        "value": {
          "kind": "solid",
          "color": "#D2691E"
        }
      },
      {
        "name": "Sunset reef",
        "value": {
          "kind": "solid",
          "color": "#F26722"
        }
      },
      {
        "name": "Tiger coral",
        "value": {
          "kind": "solid",
          "color": "#FF8C00"
        }
      },
      {
        "name": "Pink coral",
        "value": {
          "kind": "solid",
          "color": "#FA8173"
        }
      },
      {
        "name": "Seashell glow",
        "value": {
          "kind": "solid",
          "color": "#FFA07A"
        }
      },
      {
        "name": "Sand",
        "value": {
          "kind": "solid",
          "color": "#F4E2C1"
        }
      },
      {
        "name": "Golden kelp",
        "value": {
          "kind": "solid",
          "color": "#FFD700"
        }
      },
      {
        "name": "Sunlit dune",
        "value": {
          "kind": "solid",
          "color": "#F7B763"
        }
      },
      {
        "name": "Amber nautilus",
        "value": {
          "kind": "solid",
          "color": "#FFAA33"
        }
      },
      {
        "name": "Sea lemon",
        "value": {
          "kind": "solid",
          "color": "#FFEB31"
        }
      },
      {
        "name": "Pale starfish",
        "value": {
          "kind": "solid",
          "color": "#D4ED91"
        }
      },
      {
        "name": "Spring tide",
        "value": {
          "kind": "solid",
          "color": "#00FF7F"
        }
      },
      {
        "name": "Lime algae",
        "value": {
          "kind": "solid",
          "color": "#32CD32"
        }
      },
      {
        "name": "Sea grass",
        "value": {
          "kind": "solid",
          "color": "#A4C41E"
        }
      },
      {
        "name": "Neon plankton",
        "value": {
          "kind": "solid",
          "color": "#7CFC00"
        }
      },
      {
        "name": "Kelp forest",
        "value": {
          "kind": "solid",
          "color": "#228B22"
        }
      },
      {
        "name": "Emerald wave",
        "value": {
          "kind": "solid",
          "color": "#008000"
        }
      },
      {
        "name": "Whale shadow",
        "value": {
          "kind": "solid",
          "color": "#345B2F"
        }
      },
      {
        "name": "Sea turtle",
        "value": {
          "kind": "solid",
          "color": "#2E8B57"
        }
      },
      {
        "name": "Lagoon",
        "value": {
          "kind": "solid",
          "color": "#00C1AE"
        }
      },
      {
        "name": "Tropical current",
        "value": {
          "kind": "solid",
          "color": "#20B2AA"
        }
      },
      {
        "name": "Midnight trench",
        "value": {
          "kind": "solid",
          "color": "#115877"
        }
      },
      {
        "name": "Dark kelp",
        "value": {
          "kind": "solid",
          "color": "#008B8B"
        }
      },
      {
        "name": "Crystal surf",
        "value": {
          "kind": "solid",
          "color": "#00FFFF"
        }
      },
      {
        "name": "Turquoise bay",
        "value": {
          "kind": "solid",
          "color": "#40E0D0"
        }
      },
      {
        "name": "Sky over reef",
        "value": {
          "kind": "solid",
          "color": "#2EBDEF"
        }
      },
      {
        "name": "Shallow sky",
        "value": {
          "kind": "solid",
          "color": "#87CEEB"
        }
      },
      {
        "name": "Electric bel",
        "value": {
          "kind": "solid",
          "color": "#1E90FF"
        }
      },
      {
        "name": "Dolphin",
        "value": {
          "kind": "solid",
          "color": "#4169E1"
        }
      },
      {
        "name": "Ocean depths",
        "value": {
          "kind": "solid",
          "color": "#0000CD"
        }
      },
      {
        "name": "Whale",
        "value": {
          "kind": "solid",
          "color": "#191970"
        }
      },
      {
        "name": "Indigo abyss",
        "value": {
          "kind": "solid",
          "color": "#4B0082"
        }
      },
      {
        "name": "Sea urchin",
        "value": {
          "kind": "solid",
          "color": "#7841CE"
        }
      },
      {
        "name": "Lavender coral",
        "value": {
          "kind": "solid",
          "color": "#9370DB"
        }
      },
      {
        "name": "Violet tide",
        "value": {
          "kind": "solid",
          "color": "#800080"
        }
      },
      {
        "name": "Deep sea orchid",
        "value": {
          "kind": "solid",
          "color": "#8B008B"
        }
      },
      {
        "name": "Neon jelly",
        "value": {
          "kind": "solid",
          "color": "#FF00FF"
        }
      },
      {
        "name": "Fuchsia coral",
        "value": {
          "kind": "solid",
          "color": "#ED1E79"
        }
      },
      {
        "name": "Pink jellyfish",
        "value": {
          "kind": "solid",
          "color": "#FF69B4"
        }
      },
      {
        "name": "Foam",
        "value": {
          "kind": "solid",
          "color": "#FFFFFF"
        }
      },
      {
        "name": "Seashell white",
        "value": {
          "kind": "solid",
          "color": "#D3D3D3"
        }
      },
      {
        "name": "Pebble gray",
        "value": {
          "kind": "solid",
          "color": "#808080"
        }
      },
      {
        "name": "Storm cloud",
        "value": {
          "kind": "solid",
          "color": "#696969"
        }
      },
      {
        "name": "Ink black",
        "value": {
          "kind": "solid",
          "color": "#000000"
        }
      }
    ]
  },
  {
    "id": "ral",
    "name": "RAL Classic (approximate)",
    "colors": [
      {
        "name": "1000 Green beige",
        "value": {
          "kind": "solid",
          "color": "#716F52"
        }
      },
      {
        "name": "1001 Beige",
        "value": {
          "kind": "solid",
          "color": "#9B8E79"
        }
      },
      {
        "name": "1002 Sand yellow",
        "value": {
          "kind": "solid",
          "color": "#D4BB87"
        }
      },
      {
        "name": "1003 Signal yellow",
        "value": {
          "kind": "solid",
          "color": "#F4A460"
        }
      },
      {
        "name": "1004 Golden yellow",
        "value": {
          "kind": "solid",
          "color": "#EFBF04"
        }
      },
      {
        "name": "1005 Honey yellow",
        "value": {
          "kind": "solid",
          "color": "#D7A500"
        }
      },
      {
        "name": "1006 Maize yellow",
        "value": {
          "kind": "solid",
          "color": "#F2D185"
        }
      },
      {
        "name": "1007 Dalmatian yellow",
        "value": {
          "kind": "solid",
          "color": "#FDD185"
        }
      },
      {
        "name": "1011 Brown beige",
        "value": {
          "kind": "solid",
          "color": "#8B7D6B"
        }
      },
      {
        "name": "1012 Lemon yellow",
        "value": {
          "kind": "solid",
          "color": "#F5DB50"
        }
      },
      {
        "name": "1013 Oyster white",
        "value": {
          "kind": "solid",
          "color": "#F3E5AB"
        }
      },
      {
        "name": "1014 Ivory",
        "value": {
          "kind": "solid",
          "color": "#F8E4BC"
        }
      },
      {
        "name": "1015 Light ivory",
        "value": {
          "kind": "solid",
          "color": "#FAE6D3"
        }
      },
      {
        "name": "1018 Zinc yellow",
        "value": {
          "kind": "solid",
          "color": "#E4B922"
        }
      },
      {
        "name": "1019 Grey beige",
        "value": {
          "kind": "solid",
          "color": "#A19D94"
        }
      },
      {
        "name": "1020 Olive yellow",
        "value": {
          "kind": "solid",
          "color": "#B9975B"
        }
      },
      {
        "name": "1021 Rape yellow",
        "value": {
          "kind": "solid",
          "color": "#B8860B"
        }
      },
      {
        "name": "1023 Traffic yellow",
        "value": {
          "kind": "solid",
          "color": "#FF8C00"
        }
      },
      {
        "name": "1024 Ochre yellow",
        "value": {
          "kind": "solid",
          "color": "#CC7722"
        }
      },
      {
        "name": "1026 Traffic orange yellow",
        "value": {
          "kind": "solid",
          "color": "#FDBA37"
        }
      },
      {
        "name": "1027 Curry",
        "value": {
          "kind": "solid",
          "color": "#F3A55C"
        }
      },
      {
        "name": "1028 Melon yellow",
        "value": {
          "kind": "solid",
          "color": "#E87C33"
        }
      },
      {
        "name": "1032 Broom yellow",
        "value": {
          "kind": "solid",
          "color": "#F2A641"
        }
      },
      {
        "name": "1033 Dahlia yellow",
        "value": {
          "kind": "solid",
          "color": "#E09F39"
        }
      },
      {
        "name": "1034 Pastel yellow",
        "value": {
          "kind": "solid",
          "color": "#F0B76E"
        }
      },
      {
        "name": "1035 Pearl beige",
        "value": {
          "kind": "solid",
          "color": "#D1BCA0"
        }
      },
      {
        "name": "1036 Pearl gold",
        "value": {
          "kind": "solid",
          "color": "#D4AF37"
        }
      },
      {
        "name": "1037 Sun yellow",
        "value": {
          "kind": "solid",
          "color": "#F7C64F"
        }
      },
      {
        "name": "2000 Yellow orange",
        "value": {
          "kind": "solid",
          "color": "#F28C38"
        }
      },
      {
        "name": "2001 Deep orange",
        "value": {
          "kind": "solid",
          "color": "#E55B2B"
        }
      },
      {
        "name": "2002 Vermilion",
        "value": {
          "kind": "solid",
          "color": "#E34234"
        }
      },
      {
        "name": "2003 Pearl orange",
        "value": {
          "kind": "solid",
          "color": "#F27B33"
        }
      },
      {
        "name": "2004 Pure orange",
        "value": {
          "kind": "solid",
          "color": "#F37322"
        }
      },
      {
        "name": "2005 Luminous orange",
        "value": {
          "kind": "solid",
          "color": "#F75C03"
        }
      },
      {
        "name": "2007 Luminous bright orange",
        "value": {
          "kind": "solid",
          "color": "#F46C1F"
        }
      },
      {
        "name": "2008 Bright red orange",
        "value": {
          "kind": "solid",
          "color": "#E14423"
        }
      },
      {
        "name": "2009 Traffic orange",
        "value": {
          "kind": "solid",
          "color": "#F28500"
        }
      },
      {
        "name": "2010 Signal orange",
        "value": {
          "kind": "solid",
          "color": "#F46A0A"
        }
      },
      {
        "name": "2011 Deep orange",
        "value": {
          "kind": "solid",
          "color": "#E0490C"
        }
      },
      {
        "name": "2012 Salmon orange",
        "value": {
          "kind": "solid",
          "color": "#F46F42"
        }
      },
      {
        "name": "2013 Pearl orange",
        "value": {
          "kind": "solid",
          "color": "#E6761C"
        }
      },
      {
        "name": "2015 Pearl pink",
        "value": {
          "kind": "solid",
          "color": "#E8A18B"
        }
      },
      {
        "name": "2016 Copper orange",
        "value": {
          "kind": "solid",
          "color": "#B8612C"
        }
      },
      {
        "name": "2017 Signal brown",
        "value": {
          "kind": "solid",
          "color": "#8B4513"
        }
      },
      {
        "name": "2018 Fir orange",
        "value": {
          "kind": "solid",
          "color": "#C14A0F"
        }
      },
      {
        "name": "2020 Signal red",
        "value": {
          "kind": "solid",
          "color": "#BC2E1F"
        }
      },
      {
        "name": "2021 Luminous red",
        "value": {
          "kind": "solid",
          "color": "#D52713"
        }
      },
      {
        "name": "2022 Carmine red",
        "value": {
          "kind": "solid",
          "color": "#9F261E"
        }
      },
      {
        "name": "2023 Pearl carmine red",
        "value": {
          "kind": "solid",
          "color": "#D53832"
        }
      },
      {
        "name": "2024 Pure red",
        "value": {
          "kind": "solid",
          "color": "#C2341C"
        }
      },
      {
        "name": "2025 Luminous deep red",
        "value": {
          "kind": "solid",
          "color": "#B32D1C"
        }
      },
      {
        "name": "2027 Currant red",
        "value": {
          "kind": "solid",
          "color": "#A62320"
        }
      },
      {
        "name": "2028 Pearl ruby red",
        "value": {
          "kind": "solid",
          "color": "#B9301E"
        }
      },
      {
        "name": "3000 Fire red",
        "value": {
          "kind": "solid",
          "color": "#A91D2E"
        }
      },
      {
        "name": "3001 Signal red",
        "value": {
          "kind": "solid",
          "color": "#A1262A"
        }
      },
      {
        "name": "3002 Carmine red",
        "value": {
          "kind": "solid",
          "color": "#8F2626"
        }
      },
      {
        "name": "3003 Ruby red",
        "value": {
          "kind": "solid",
          "color": "#9B2428"
        }
      },
      {
        "name": "3004 Purple red",
        "value": {
          "kind": "solid",
          "color": "#872241"
        }
      },
      {
        "name": "3005 Wine red",
        "value": {
          "kind": "solid",
          "color": "#722F37"
        }
      },
      {
        "name": "3007 Black red",
        "value": {
          "kind": "solid",
          "color": "#3D1818"
        }
      },
      {
        "name": "3009 Oxide red",
        "value": {
          "kind": "solid",
          "color": "#8A3324"
        }
      },
      {
        "name": "3011 Brown red",
        "value": {
          "kind": "solid",
          "color": "#A22C29"
        }
      },
      {
        "name": "3012 Pine red",
        "value": {
          "kind": "solid",
          "color": "#B22D20"
        }
      },
      {
        "name": "3013 Tomato red",
        "value": {
          "kind": "solid",
          "color": "#D23741"
        }
      },
      {
        "name": "3014 Antique pink",
        "value": {
          "kind": "solid",
          "color": "#A8282E"
        }
      },
      {
        "name": "3015 Light pink",
        "value": {
          "kind": "solid",
          "color": "#C8283C"
        }
      },
      {
        "name": "3016 Coral red",
        "value": {
          "kind": "solid",
          "color": "#D23F39"
        }
      },
      {
        "name": "3017 Rose",
        "value": {
          "kind": "solid",
          "color": "#D1425E"
        }
      },
      {
        "name": "3018 Strawberry red",
        "value": {
          "kind": "solid",
          "color": "#C4232F"
        }
      },
      {
        "name": "3020 Traffic red",
        "value": {
          "kind": "solid",
          "color": "#C8102E"
        }
      },
      {
        "name": "3022 Salmon pink",
        "value": {
          "kind": "solid",
          "color": "#E36A5A"
        }
      },
      {
        "name": "3024 Luminous rose",
        "value": {
          "kind": "solid",
          "color": "#E63E62"
        }
      },
      {
        "name": "3026 Luminous bright red",
        "value": {
          "kind": "solid",
          "color": "#E02A27"
        }
      },
      {
        "name": "3027 Raspberry red",
        "value": {
          "kind": "solid",
          "color": "#B8315F"
        }
      },
      {
        "name": "3028 Pure red",
        "value": {
          "kind": "solid",
          "color": "#C61C23"
        }
      },
      {
        "name": "3031 Orient red",
        "value": {
          "kind": "solid",
          "color": "#AD2932"
        }
      },
      {
        "name": "3032 Pearl ruby",
        "value": {
          "kind": "solid",
          "color": "#D32F2F"
        }
      },
      {
        "name": "3033 Pearl pink",
        "value": {
          "kind": "solid",
          "color": "#D13C6F"
        }
      },
      {
        "name": "4001 Red purple",
        "value": {
          "kind": "solid",
          "color": "#7B2B5F"
        }
      },
      {
        "name": "4002 Red violet",
        "value": {
          "kind": "solid",
          "color": "#912E8C"
        }
      },
      {
        "name": "4003 Heather violet",
        "value": {
          "kind": "solid",
          "color": "#9C366F"
        }
      },
      {
        "name": "4004 Bordeaux violet",
        "value": {
          "kind": "solid",
          "color": "#6A1F49"
        }
      },
      {
        "name": "4005 Blue violet",
        "value": {
          "kind": "solid",
          "color": "#4B2663"
        }
      },
      {
        "name": "4006 Mahogany",
        "value": {
          "kind": "solid",
          "color": "#5C2D3C"
        }
      },
      {
        "name": "4007 Grey purple",
        "value": {
          "kind": "solid",
          "color": "#5E3559"
        }
      },
      {
        "name": "4008 Signal violet",
        "value": {
          "kind": "solid",
          "color": "#9C3568"
        }
      },
      {
        "name": "4009 Fir green",
        "value": {
          "kind": "solid",
          "color": "#5E6E3A"
        }
      },
      {
        "name": "4010 Sabine grey",
        "value": {
          "kind": "solid",
          "color": "#5B5B8A"
        }
      },
      {
        "name": "4011 Pearl violet",
        "value": {
          "kind": "solid",
          "color": "#8F3A70"
        }
      },
      {
        "name": "4012 Pearl blackberry",
        "value": {
          "kind": "solid",
          "color": "#5E3252"
        }
      },
      {
        "name": "5001 Green blue",
        "value": {
          "kind": "solid",
          "color": "#1B4F72"
        }
      },
      {
        "name": "5002 Ultramarine blue",
        "value": {
          "kind": "solid",
          "color": "#18669E"
        }
      },
      {
        "name": "5003 Sapphire blue",
        "value": {
          "kind": "solid",
          "color": "#0F4C8A"
        }
      },
      {
        "name": "5004 Black blue",
        "value": {
          "kind": "solid",
          "color": "#0D324A"
        }
      },
      {
        "name": "5005 Signal blue",
        "value": {
          "kind": "solid",
          "color": "#1B5583"
        }
      },
      {
        "name": "5007 Brilliant blue",
        "value": {
          "kind": "solid",
          "color": "#2C5F9D"
        }
      },
      {
        "name": "5008 Grey blue",
        "value": {
          "kind": "solid",
          "color": "#3B5AA9"
        }
      },
      {
        "name": "5009 Azure blue",
        "value": {
          "kind": "solid",
          "color": "#0077A3"
        }
      },
      {
        "name": "5010 Gentian blue",
        "value": {
          "kind": "solid",
          "color": "#0A558C"
        }
      },
      {
        "name": "5011 Steel blue",
        "value": {
          "kind": "solid",
          "color": "#2B547E"
        }
      },
      {
        "name": "5012 Light blue",
        "value": {
          "kind": "solid",
          "color": "#0066A1"
        }
      },
      {
        "name": "5013 Cobalt blue",
        "value": {
          "kind": "solid",
          "color": "#124780"
        }
      },
      {
        "name": "5014 Pigeon blue",
        "value": {
          "kind": "solid",
          "color": "#1F4E79"
        }
      },
      {
        "name": "5015 Sky blue",
        "value": {
          "kind": "solid",
          "color": "#0384A7"
        }
      },
      {
        "name": "5017 Traffic blue",
        "value": {
          "kind": "solid",
          "color": "#006A9E"
        }
      },
      {
        "name": "5018 Turquoise blue",
        "value": {
          "kind": "solid",
          "color": "#005F87"
        }
      },
      {
        "name": "5019 Capsanthin violet",
        "value": {
          "kind": "solid",
          "color": "#5A3D5B"
        }
      },
      {
        "name": "5020 Ocean blue",
        "value": {
          "kind": "solid",
          "color": "#04749F"
        }
      },
      {
        "name": "5021 Water blue",
        "value": {
          "kind": "solid",
          "color": "#009AAA"
        }
      },
      {
        "name": "5022 Night blue",
        "value": {
          "kind": "solid",
          "color": "#1A3D5F"
        }
      },
      {
        "name": "5023 Distant blue",
        "value": {
          "kind": "solid",
          "color": "#047AA6"
        }
      },
      {
        "name": "5024 Pastel blue",
        "value": {
          "kind": "solid",
          "color": "#5B9BB8"
        }
      },
      {
        "name": "5025 Pearl gentian blue",
        "value": {
          "kind": "solid",
          "color": "#3C6A98"
        }
      },
      {
        "name": "5026 Pearl midnight blue",
        "value": {
          "kind": "solid",
          "color": "#1C3F5F"
        }
      },
      {
        "name": "6000 Patina green",
        "value": {
          "kind": "solid",
          "color": "#36673A"
        }
      },
      {
        "name": "6001 Emerald green",
        "value": {
          "kind": "solid",
          "color": "#0E5C34"
        }
      },
      {
        "name": "6002 Leaf green",
        "value": {
          "kind": "solid",
          "color": "#437034"
        }
      },
      {
        "name": "6003 Olive green",
        "value": {
          "kind": "solid",
          "color": "#3F3F2A"
        }
      },
      {
        "name": "6004 Blue green",
        "value": {
          "kind": "solid",
          "color": "#2B4E52"
        }
      },
      {
        "name": "6005 Moss green",
        "value": {
          "kind": "solid",
          "color": "#3B5F3F"
        }
      },
      {
        "name": "6006 Grey olive",
        "value": {
          "kind": "solid",
          "color": "#4A563C"
        }
      },
      {
        "name": "6007 Pine green",
        "value": {
          "kind": "solid",
          "color": "#2B4638"
        }
      },
      {
        "name": "6008 Pine brown",
        "value": {
          "kind": "solid",
          "color": "#4A4139"
        }
      },
      {
        "name": "6009 Fir green",
        "value": {
          "kind": "solid",
          "color": "#3B3A2E"
        }
      },
      {
        "name": "6010 Grass green",
        "value": {
          "kind": "solid",
          "color": "#3E7A5F"
        }
      },
      {
        "name": "6011 Reseda green",
        "value": {
          "kind": "solid",
          "color": "#5E716A"
        }
      },
      {
        "name": "6012 Brown green",
        "value": {
          "kind": "solid",
          "color": "#3A4E48"
        }
      },
      {
        "name": "6013 Reed green",
        "value": {
          "kind": "solid",
          "color": "#6B8E23"
        }
      },
      {
        "name": "6014 Yellow green",
        "value": {
          "kind": "solid",
          "color": "#6B8E23"
        }
      },
      {
        "name": "6015 Black green",
        "value": {
          "kind": "solid",
          "color": "#1E3E2F"
        }
      },
      {
        "name": "6016 Turquoise green",
        "value": {
          "kind": "solid",
          "color": "#1E4D4B"
        }
      },
      {
        "name": "6017 May green",
        "value": {
          "kind": "solid",
          "color": "#4C7C47"
        }
      },
      {
        "name": "6018 Yellow green",
        "value": {
          "kind": "solid",
          "color": "#9CBF60"
        }
      },
      {
        "name": "6019 Pine green",
        "value": {
          "kind": "solid",
          "color": "#2E5A3A"
        }
      },
      {
        "name": "6020 Chrome oxide green",
        "value": {
          "kind": "solid",
          "color": "#2E5A3A"
        }
      },
      {
        "name": "6021 Pale green",
        "value": {
          "kind": "solid",
          "color": "#9DC0A5"
        }
      },
      {
        "name": "6022 Brown green",
        "value": {
          "kind": "solid",
          "color": "#4A563C"
        }
      },
      {
        "name": "6024 Traffic green",
        "value": {
          "kind": "solid",
          "color": "#009E60"
        }
      },
      {
        "name": "6025 Fern green",
        "value": {
          "kind": "solid",
          "color": "#3F7044"
        }
      },
      {
        "name": "6026 Opal green",
        "value": {
          "kind": "solid",
          "color": "#4F7942"
        }
      },
      {
        "name": "6027 Pine green",
        "value": {
          "kind": "solid",
          "color": "#3B5F3F"
        }
      },
      {
        "name": "6028 Pine green",
        "value": {
          "kind": "solid",
          "color": "#3B5F3F"
        }
      },
      {
        "name": "6029 Mint green",
        "value": {
          "kind": "solid",
          "color": "#00A550"
        }
      },
      {
        "name": "6031 Bronze green",
        "value": {
          "kind": "solid",
          "color": "#3E5A40"
        }
      },
      {
        "name": "6032 Pearl green",
        "value": {
          "kind": "solid",
          "color": "#3D7E5A"
        }
      },
      {
        "name": "6033 Sax turquoise",
        "value": {
          "kind": "solid",
          "color": "#007D6E"
        }
      },
      {
        "name": "6034 Pearl turquoise",
        "value": {
          "kind": "solid",
          "color": "#3D7E5A"
        }
      },
      {
        "name": "6035 Pearl green",
        "value": {
          "kind": "solid",
          "color": "#3D7E5A"
        }
      },
      {
        "name": "6036 Pearl jade",
        "value": {
          "kind": "solid",
          "color": "#3D7E5A"
        }
      },
      {
        "name": "6037 Pure green",
        "value": {
          "kind": "solid",
          "color": "#00A550"
        }
      },
      {
        "name": "6038 Luminous green",
        "value": {
          "kind": "solid",
          "color": "#00A550"
        }
      },
      {
        "name": "6039 Mint green",
        "value": {
          "kind": "solid",
          "color": "#00A550"
        }
      },
      {
        "name": "7000 Squirrel grey",
        "value": {
          "kind": "solid",
          "color": "#7D7D7D"
        }
      },
      {
        "name": "7001 Silver grey",
        "value": {
          "kind": "solid",
          "color": "#A8A9AD"
        }
      },
      {
        "name": "7002 Olivestone",
        "value": {
          "kind": "solid",
          "color": "#6F7368"
        }
      },
      {
        "name": "7003 Moss grey",
        "value": {
          "kind": "solid",
          "color": "#8F9080"
        }
      },
      {
        "name": "7004 Signal grey",
        "value": {
          "kind": "solid",
          "color": "#8E9291"
        }
      },
      {
        "name": "7005 Mouse grey",
        "value": {
          "kind": "solid",
          "color": "#8B8788"
        }
      },
      {
        "name": "7006 Beige grey",
        "value": {
          "kind": "solid",
          "color": "#9A8373"
        }
      },
      {
        "name": "7008 Khaki grey",
        "value": {
          "kind": "solid",
          "color": "#828C6A"
        }
      },
      {
        "name": "7009 Green grey",
        "value": {
          "kind": "solid",
          "color": "#6F7368"
        }
      },
      {
        "name": "7010 Tarpaulin grey",
        "value": {
          "kind": "solid",
          "color": "#5F6563"
        }
      },
      {
        "name": "7011 Iron grey",
        "value": {
          "kind": "solid",
          "color": "#4A5656"
        }
      },
      {
        "name": "7012 Basalt grey",
        "value": {
          "kind": "solid",
          "color": "#4D5656"
        }
      },
      {
        "name": "7013 Brown grey",
        "value": {
          "kind": "solid",
          "color": "#635147"
        }
      },
      {
        "name": "7015 Slate grey",
        "value": {
          "kind": "solid",
          "color": "#6B6B83"
        }
      },
      {
        "name": "7016 Anthracite grey",
        "value": {
          "kind": "solid",
          "color": "#32373D"
        }
      },
      {
        "name": "7021 Light grey",
        "value": {
          "kind": "solid",
          "color": "#8B8B83"
        }
      },
      {
        "name": "7022 Umber grey",
        "value": {
          "kind": "solid",
          "color": "#716347"
        }
      },
      {
        "name": "7023 Concrete grey",
        "value": {
          "kind": "solid",
          "color": "#76787A"
        }
      },
      {
        "name": "7024 Graphite grey",
        "value": {
          "kind": "solid",
          "color": "#5E6565"
        }
      },
      {
        "name": "7026 Granite grey",
        "value": {
          "kind": "solid",
          "color": "#5E6565"
        }
      },
      {
        "name": "7030 Stone grey",
        "value": {
          "kind": "solid",
          "color": "#8F9494"
        }
      },
      {
        "name": "7031 Iron grey",
        "value": {
          "kind": "solid",
          "color": "#4A5656"
        }
      },
      {
        "name": "7032 Pebble grey",
        "value": {
          "kind": "solid",
          "color": "#B2BFC0"
        }
      },
      {
        "name": "7033 Cement grey",
        "value": {
          "kind": "solid",
          "color": "#9B9B9B"
        }
      },
      {
        "name": "7034 Yellow grey",
        "value": {
          "kind": "solid",
          "color": "#8F9D9B"
        }
      },
      {
        "name": "7035 Light grey",
        "value": {
          "kind": "solid",
          "color": "#CBD0CC"
        }
      },
      {
        "name": "7036 Platinum grey",
        "value": {
          "kind": "solid",
          "color": "#6D7A80"
        }
      },
      {
        "name": "7037 Dusty grey",
        "value": {
          "kind": "solid",
          "color": "#8A9191"
        }
      },
      {
        "name": "7038 Agate grey",
        "value": {
          "kind": "solid",
          "color": "#7E8181"
        }
      },
      {
        "name": "7039 Quartz grey",
        "value": {
          "kind": "solid",
          "color": "#6E7D7E"
        }
      },
      {
        "name": "7040 Window grey",
        "value": {
          "kind": "solid",
          "color": "#8A9191"
        }
      },
      {
        "name": "7042 Traffic grey A",
        "value": {
          "kind": "solid",
          "color": "#8A9191"
        }
      },
      {
        "name": "7043 Traffic grey B",
        "value": {
          "kind": "solid",
          "color": "#6E7D7E"
        }
      },
      {
        "name": "7044 Silk grey",
        "value": {
          "kind": "solid",
          "color": "#9B9B9B"
        }
      },
      {
        "name": "7045 Telegrey 1",
        "value": {
          "kind": "solid",
          "color": "#A1A7B0"
        }
      },
      {
        "name": "7046 Telegrey 2",
        "value": {
          "kind": "solid",
          "color": "#7E848C"
        }
      },
      {
        "name": "7047 Telegrey 4",
        "value": {
          "kind": "solid",
          "color": "#7E848C"
        }
      },
      {
        "name": "7048 Pearl mouse grey",
        "value": {
          "kind": "solid",
          "color": "#6D7A80"
        }
      },
      {
        "name": "8000 Green brown",
        "value": {
          "kind": "solid",
          "color": "#786D5F"
        }
      },
      {
        "name": "8001 Ochre brown",
        "value": {
          "kind": "solid",
          "color": "#8B7355"
        }
      },
      {
        "name": "8003 Clay brown",
        "value": {
          "kind": "solid",
          "color": "#8B6F47"
        }
      },
      {
        "name": "8004 Copper brown",
        "value": {
          "kind": "solid",
          "color": "#8B6F47"
        }
      },
      {
        "name": "8007 Chocolate brown",
        "value": {
          "kind": "solid",
          "color": "#5C4033"
        }
      },
      {
        "name": "8008 Olive brown",
        "value": {
          "kind": "solid",
          "color": "#6E5C4A"
        }
      },
      {
        "name": "8011 Nut brown",
        "value": {
          "kind": "solid",
          "color": "#8B4513"
        }
      },
      {
        "name": "8012 Red brown",
        "value": {
          "kind": "solid",
          "color": "#8B4513"
        }
      },
      {
        "name": "8014 Sepia brown",
        "value": {
          "kind": "solid",
          "color": "#5C3317"
        }
      },
      {
        "name": "8015 Chestnut brown",
        "value": {
          "kind": "solid",
          "color": "#854636"
        }
      },
      {
        "name": "8016 Mahogany brown",
        "value": {
          "kind": "solid",
          "color": "#8B4513"
        }
      },
      {
        "name": "8017 Chocolate brown",
        "value": {
          "kind": "solid",
          "color": "#5C3317"
        }
      },
      {
        "name": "8019 Grey brown",
        "value": {
          "kind": "solid",
          "color": "#786D5F"
        }
      },
      {
        "name": "8022 Chestnut brown",
        "value": {
          "kind": "solid",
          "color": "#854636"
        }
      },
      {
        "name": "8023 Pearl copper",
        "value": {
          "kind": "solid",
          "color": "#8B6F47"
        }
      },
      {
        "name": "8024 Beige brown",
        "value": {
          "kind": "solid",
          "color": "#8B7355"
        }
      },
      {
        "name": "8025 Pearl mocha brown",
        "value": {
          "kind": "solid",
          "color": "#8B6F47"
        }
      },
      {
        "name": "8027 Clay brown",
        "value": {
          "kind": "solid",
          "color": "#8B6F47"
        }
      },
      {
        "name": "8028 Earth brown",
        "value": {
          "kind": "solid",
          "color": "#8B6F47"
        }
      },
      {
        "name": "8029 Pearl brown",
        "value": {
          "kind": "solid",
          "color": "#8B6F47"
        }
      },
      {
        "name": "9001 Cream",
        "value": {
          "kind": "solid",
          "color": "#FAF0E6"
        }
      },
      {
        "name": "9002 Grey white",
        "value": {
          "kind": "solid",
          "color": "#EDECE6"
        }
      },
      {
        "name": "9003 Signal white",
        "value": {
          "kind": "solid",
          "color": "#FFFFFF"
        }
      },
      {
        "name": "9004 Signal black",
        "value": {
          "kind": "solid",
          "color": "#000000"
        }
      },
      {
        "name": "9005 Jet black",
        "value": {
          "kind": "solid",
          "color": "#1D1D1D"
        }
      },
      {
        "name": "9006 White aluminium",
        "value": {
          "kind": "solid",
          "color": "#C0C0C0"
        }
      },
      {
        "name": "9007 Grey aluminium",
        "value": {
          "kind": "solid",
          "color": "#8C7853"
        }
      },
      {
        "name": "9010 Pure white",
        "value": {
          "kind": "solid",
          "color": "#FFFFFF"
        }
      },
      {
        "name": "9011 Graphite black",
        "value": {
          "kind": "solid",
          "color": "#1D1D1D"
        }
      },
      {
        "name": "9016 Traffic white",
        "value": {
          "kind": "solid",
          "color": "#FFFFFF"
        }
      },
      {
        "name": "9017 Traffic black",
        "value": {
          "kind": "solid",
          "color": "#000000"
        }
      },
      {
        "name": "9018 Papyrus white",
        "value": {
          "kind": "solid",
          "color": "#FAF0E6"
        }
      },
      {
        "name": "9022 Pearl light grey",
        "value": {
          "kind": "solid",
          "color": "#B2BFC0"
        }
      }
    ]
  }
];
