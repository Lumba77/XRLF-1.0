import os
import sys
import json
import tempfile
from pathlib import Path

# Add the tools directory to sys.path to import mm_hooks
sys.path.append(os.path.join(os.getcwd(), "Tools", "xrlf-model", "tools"))

try:
    from mm_hooks import TTSHook, ImageGenHook, AudioGenHook, MMHookRegistry
except ImportError as e:
    print(f"Import failed: {e}")
    sys.exit(1)

def test_tts_hook():
    print("\n--- Testing TTSHook ---")
    config = {
        "enabled": True,
        "engine": "stub", # Use stub for smoke test to avoid dependency issues
        "voice": "en-us-1",
        "endpoint": "http://127.0.0.1:8000/tts"
    }
    hook = TTSHook(config)
    text = "Hello, this is a smoke test for the TTS hook."
    result = hook.speak(text)
    
    if result:
        print(f"✅ TTS Success: Output saved to {result}")
    else:
        # Since we used 'stub', it returns None but logs. 
        # In a real test we'd check if it's stubbed.
        print("ℹ️ TTS returned None (Expected if engine is 'stub')")

def test_image_gen_hook():
    print("\n--- Testing ImageGenHook ---")
    config = {
        "enabled": False, # Disabled for smoke test
        "endpoint": "http://127.0.0.1:7860"
    }
    hook = ImageGenHook(config)
    prompt = "A futuristic AI core with glowing rings"
    result = hook.generate(prompt)
    
    if result:
        print(f"✅ ImageGen Success: Output saved to {result}")
    else:
        print("ℹ️ ImageGen returned None (Expected if disabled)")

def test_audio_gen_hook():
    print("\n--- Testing AudioGenHook ---")
    hook = AudioGenHook()
    prompt = "Ambient space music"
    result = hook.generate(prompt)
    
    if result:
        print(f"✅ AudioGen Success: Output saved to {result}")
    else:
        print("ℹ️ AudioGen returned None (Expected as it is currently a stub)")

def test_registry():
    print("\n--- Testing MMHookRegistry ---")
    config = {
        "XRL_MM_HOOKS": {
            "tts": {"enabled": True, "engine": "stub"},
            "image_gen": {"enabled": False}
        }
    }
    registry = MMHookRegistry(config)
    tts = registry.get_hook("tts")
    img = registry.get_hook("image_gen")
    
    if tts and isinstance(tts, TTSHook):
        print("✅ Registry successfully loaded TTSHook")
    else:
        print("❌ Registry failed to load TTSHook")
        
    if img and isinstance(img, ImageGenHook):
        print("✅ Registry successfully loaded ImageGenHook")
    else:
        print("❌ Registry failed to load ImageGenHook")

if __name__ == "__main__":
    print("Starting Multimodal Hooks Smoke Test...")
    test_tts_hook()
    test_image_gen_hook()
    test_audio_gen_hook()
    test_registry()
    print("\nSmoke test completed.")
