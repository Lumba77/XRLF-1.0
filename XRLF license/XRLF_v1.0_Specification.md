# XRLF v

## 1.0 Specification

XRLF v

## 1.0 Specification

## 
1. Overview
XRLF (Extended Reasoning Layer Format) is a hybrid cognitive model container and runtime protocol designed to augment small language models with structured reasoning, multimodal sensory fusion, and external cognitive adapters. XRLF v1.0 defines:
- The XRLF container format
- The XRLF section schemas
- The XRLF runtime behavior
- The XRLF multimodal gateway
- The XRLF adapter API
- The XRLF compliance tests
- The XRLF versioning rules XRLF v1.1 will define planned extensions (video, memory routing, etc.). XRLF v2.0 will define the fully multimodal XRLF-native model.

## 
2. Goals
XRLF is designed to:
- Enable small models (3B-7B) to perform at 12B-70B reasoning levels
- Provide a standardized cognitive injection protocol
- Support multimodal input via external adapters
- Allow developers to extend model capabilities without retraining
- Maintain compatibility with GGUF and llama.cpp
- Provide a stable, open protocol for the community
- Offer a commercial licensing path for enterprise use

## 
3. XRLF Container Format
XRLF files are binary containers composed of:

 A header
- A section table
- A series of typed sections

## 
3.1 Header
struct XRLFHeader { char magic[4]; // "XRLF" uint32 version; // e.g., 0x00010000 for v1.0 uint32 flags; // reserved uint64 section_count; // number of sections char base_model[64]; // e.g., "Qwen2.5-3B-Instruct" char source_model[64];// e.g., "DeepSeek-R1"
};

## 
3.2 Section Table
Each section entry: struct XRLFSectionEntry { uint32 type; // section type enum uint64 offset; // byte offset uint64 length; // section length };

## 
3.3 Section Types
 0x01 - CORE_GGUF  0x02 - XRL_PRINCIPLES  0x03 - XRL_GRAPH  0x04 - XRL_CLUSTERS  0x05 - XRL_THREADS  0x06 - XRL_PROFILES  0x07 - XRL_EXPANSION  0x08 - MEMORY_HOOKS  0x09 - RUNTIME_META

## 
4. XRLF Runtime Behavior
The XRLF runtime is responsible for:
- Loading the GGUF core

 Loading XRLF cognitive structures
- Intercepting multimodal inputs
- Routing sensory data through adapters
- Injecting structured cognitive messages into the LLM
- Maintaining coherence across turns
- Providing compliance guarantees

## 
4.1 Cognitive Injection Format
Adapters produce structured messages: [System XRLF Adapter: <adapter_name>] <structured interpretation>
Examples: [System Audio Adapter: Detected a 440 Hz continuous sine wave (A4 note)] [System Vision Adapter: Image contains a cat sitting on a windowsill]

## 
5. XRLF Multimodal Gateway
The gateway intercepts:  input_audio  image_url  video_url (v1.1)  binary_payload It routes them to adapters, receives structured interpretations, and injects them into the LLM.

## 
6. XRLF Adapter API (Dual)

## 
6.1 Python Interface
class XRLFAdapter: def __init__(self): pass
def supports(self) -> list[str]: return ["audio/wav", "image/png"]
def process(self, payload: bytes) -> str: """ Returns a structured cognitive interpretation string. """ raise NotImplementedError

## 
6.2 JSON Schema Interface
{ "adapter_name": "string", "supports": ["string"], "payload": "base64", "output": "string"
}
XRLF License Model (Draft - Part 1)
Base license: Apache 

## 2.0 Commercial exception:
XRLF is free for individuals, researchers, students, open-source projects, and companies with annual revenue under 500,

## 000. Companies above this threshold must obtain a commercial XRLF license for production use, redistribution, or integration into proprietary systems.
XRLF Commercial License Tiers (Conservative)
 Indie License - 0
- Startup License - 0
- Small Business License - 300/year

 Medium Business License - 1,000/year
- Enterprise License - 5,000/year
- OEM License - 10,000/year
- Cloud Provider License - 25,000/year
