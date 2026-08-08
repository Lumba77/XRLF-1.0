# XRLF Adapter API Specification

XRLF Adapter API - Full Specification (Dual API)

## 
1. Purpose
The XRLF Adapter API defines how external sensory modules ("adapters") integrate with the XRLF runtime. Adapters allow XRLF to process multimodal inputs such as:
- Audio
- Images
- Video
- Binary sensor data
- Robotics telemetry
- Custom modalities The API is intentionally simple, stable, and language-agnostic.

## 
2. Design Principles
The XRLF Adapter API follows these principles:
- Modularity - adapters are plug-and-play
- Language neutrality - Python-first, JSON schema second
- Determinism - adapters produce structured, predictable output
- Safety - adapters cannot execute arbitrary code inside the LLM
- Interoperability - all XRLF runtimes must support the same API
- Extensibility - new modalities can be added without changing the core spec

## 
3. Adapter Lifecycle
An XRLF adapter follows this lifecycle: 

## 1. Registration
The adapter declares its name and supported MIME types. 

## 2. Interception
The XRLF gateway detects multimodal payloads and routes them to the correct adapter. 

## 3. Processing
The adapter receives raw bytes and produces a structured cognitive interpretation.

## 
4. Injection The XRLF runtime injects the interpretation into the LLM as a system message.

## 
5. Completion The LLM responds using the interpretation as context.
1.

## 
4. Python API Specification
Python is the primary API for hobbyists, researchers, and rapid prototyping.

## 
4.1 Base Class
class XRLFAdapter: def __init__(self): """ Initialize adapter resources. """ pass
def name(self) -> str: """ Returns the adapter's unique name. Example: "audio.dsp.440hz" """ raise NotImplementedError
def supports(self) -> list[str]: """ Returns a list of supported MIME types. Example: ["audio/wav", "audio/mpeg"] """ raise NotImplementedError
def process(self, payload: bytes) -> str: """ Processes raw bytes and returns a structured cognitive interpretation. Example output: "[System Audio Adapter: Detected a 440 Hz continuous sine wave (A4 note)]" """ raise NotImplementedError

## 
4.2 Example Adapter (Audio DSP)
class Audio440HzAdapter(XRLFAdapter): def name(self): return "audio.dsp.440hz"
def supports(self): return ["audio/wav"]
def process(self, payload: bytes) -> str: freq = detect_frequency(payload) if abs(freq - 440) < 2: return "[System Audio Adapter: Detected a 440 Hz continuous sine wave (A4 note)]" return f"[System Audio Adapter: Detected frequency {freq} Hz]"

## 
5. JSON Schema API Specification
The JSON API is designed for enterprise, cloud providers, and cross-language implementations.

## 
5.1 JSON Schema
{ "type": "object", "properties": { "adapter_name": { "type": "string" }, "supports": { "type": "array", "items": { "type": "string" } }, "payload": { "type": "string", "description": "Base64-encoded bytes" }, "output": { "type": "string" } }, "required": ["adapter_name", "supports", "payload"]
}

## 
5.2 JSON Processing Contract
Input: { "adapter_name": "vision.basic", "supports": ["image/png"], "payload": "<base64>" }
Output:

{ "output": "[System Vision Adapter: Image contains a cat sitting on a windowsill]"
}

## 
6. Adapter Registration
Adapters must register themselves with the XRLF runtime.

## 
6.1 Python Registration
runtime.register_adapter(Audio440HzAdapter())

## 
6.2 JSON Registration
{ "register": { "adapter_name": "vision.basic", "supports": ["image/png"] }
}

## 
7. Structured Cognitive Interpretation
Adapters must output structured messages in the following format: [System <Adapter Type>: <Interpretation>]
Examples: [System Audio Adapter: Detected a 440 Hz continuous sine wave (A4 note)] [System Vision Adapter: Image contains a cat sitting on a windowsill] [System Video Adapter: Detected motion trajectory: human walking left-to-right]

## 
8. Error Handling
Adapters must return structured error messages: [System Adapter Error: Unsupported format] [System Adapter Error: Payload corrupted] [System Adapter Error: Processing failure]

## 
9. Security Requirements
Adapters must:
- Never execute arbitrary code
- Never access external networks

 Never modify the LLM state directly
- Never return raw binary data
- Never return unstructured text All output must be deterministic and structured.

## 
10. Compliance Requirements
To be XRLF-compliant, an adapter must:
- Implement the full API
- Produce structured output
- Pass the XRLF adapter compliance tests
- Register correctly
- Handle errors gracefully The compliance suite will be drafted next in XRLF_COMPLIANCE.md. You can continue with XRLF compliance tests.
