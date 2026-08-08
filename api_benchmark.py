import urllib.request
import json
import time
import base64

API_URL = "http://127.0.0.1:8300/v1/chat/completions"

def run_test(name, messages):
    print(f"\n{'='*60}\n▶ Running Test: {name}\n{'='*60}", flush=True)
    
    data = {
        "messages": messages,
        "max_tokens": 512,
        "temperature": 0.2
    }
    
    req = urllib.request.Request(
        API_URL, 
        data=json.dumps(data).encode("utf-8"), 
        headers={"Content-Type": "application/json"}, 
        method="POST"
    )
    
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
            elapsed = time.time() - t0
            
            reply = result["choices"][0]["message"]["content"]
            print(f"✅ Success! (Response time: {elapsed:.2f}s)\n", flush=True)
            print("Response:\n" + "-"*40, flush=True)
            print(reply, flush=True)
            print("-" * 40, flush=True)
            
    except Exception as e:
        print(f"❌ Error during test: {e}", flush=True)


def main():
    # 1. Spatial / Logical Reasoning Test
    run_test("Spatial & Logical Reasoning", [
        {"role": "system", "content": "You are a highly intelligent logic solver."},
        {"role": "user", "content": "I place a coin on the table. I take an empty cup and put it upside down over the coin. Then, I pick up the cup and place it on the floor. Where is the coin right now? Explain step-by-step."}
    ])

    # 2. Coding Capabilities Test
    run_test("Complex Coding", [
        {"role": "system", "content": "You are an expert programmer."},
        {"role": "user", "content": "Write a short Python function to solve the Tower of Hanoi, but it MUST be completely ITERATIVE, no recursion allowed. Explain your approach briefly."}
    ])

    # 3. Vision Capabilities Test
    image_path = r"C:\Users\danie\.gemini\antigravity-ide\brain\4c9a89e5-c8b7-425f-9858-e8e9e980c88a\red_apple_1786139805830.png"
    try:
        with open(image_path, "rb") as f:
            base64_img = base64.b64encode(f.read()).decode("utf-8")
            
        run_test("Multimodal Vision Processing", [
            {"role": "system", "content": "You are a precise vision analyzer."},
            {
                "role": "user", 
                "content": [
                    {"type": "text", "text": "What do you see in this image? Be specific about the object and the surface it's on."},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_img}"}}
                ]
            }
        ])
    except Exception as e:
        print(f"Could not load image for vision test: {e}")

if __name__ == "__main__":
    print("Starting Comprehensive API Benchmark...\n")
    main()
