{
  "targets": [
    {
      "target_name": "screen_color",
      "sources": [
        "native/addon.cpp"
      ],
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "sources": [
              "native/sampler_mac.mm"
            ],
            "libraries": [
              "-framework AppKit"
            ]
          }
        ],
        [
          "OS==\"win\"",
          {
            "sources": [
              "native/sampler_win.cpp"
            ],
            "libraries": [
              "user32.lib",
              "gdi32.lib"
            ],
            "defines": [
              "NOMINMAX",
              "WIN32_LEAN_AND_MEAN"
            ]
          }
        ],
        [
          "OS==\"linux\"",
          {
            "sources": [
              "native/sampler_linux.cpp"
            ],
            "cflags": [
              "<!@(pkg-config --cflags gio-2.0)"
            ],
            "libraries": [
              "<!@(pkg-config --libs gio-2.0)"
            ]
          }
        ]
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [
            "/std:c++17",
            "/utf-8"
          ]
        }
      },
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_CPP_EXCEPTIONS",
        "NEO_VERSION=\"<!(node ../../scripts/version.mjs version)\"",
        "NEO_CORE_REVISION=\"<!(node ../../scripts/version.mjs core)\""
      ]
    },
    {
      "target_name": "screen_color_fixture",
      "sources": [
        "native/addon.cpp",
        "native/sampler_fixture.cpp"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_CPP_EXCEPTIONS",
        "SCREEN_COLOR_FIXTURE",
        "NEO_VERSION=\"<!(node ../../scripts/version.mjs version)\"",
        "NEO_CORE_REVISION=\"<!(node ../../scripts/version.mjs core)\""
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [
            "/std:c++17",
            "/utf-8"
          ]
        }
      }
    },
    {
      "target_name": "portal_test",
      "type": "none",
      "conditions": [
        [
          "OS==\"linux\"",
          {
            "type": "executable",
            "sources": [
              "test/portal.cpp",
              "native/sampler_linux.cpp"
            ],
            "cflags": [
              "<!@(pkg-config --cflags gio-2.0)"
            ],
            "cflags_cc": [
              "-std=c++17",
              "-fexceptions"
            ],
            "cflags_cc!": [
              "-fno-exceptions"
            ],
            "libraries": [
              "<!@(pkg-config --libs gio-2.0)"
            ]
          }
        ]
      ]
    }
  ]
}
