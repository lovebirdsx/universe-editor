{
  "targets": [
    {
      "target_name": "process_job",
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ['OS=="win"', {
          "sources": ["native/process_job.cc"],
          "defines": ["WIN32_LEAN_AND_MEAN", "NOMINMAX", "UNICODE", "_UNICODE"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/guard:cf", "/sdl", "/W3"]
            },
            "VCLinkerTool": {
              "AdditionalOptions": ["/DYNAMICBASE", "/guard:cf"]
            }
          }
        }]
      ]
    }
  ]
}
