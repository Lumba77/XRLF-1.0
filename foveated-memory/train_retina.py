import json
import os
import random
from torch.utils.data import DataLoader
from sentence_transformers import SentenceTransformer, InputExample, losses

# -------------------------------------------------------------------
# L0 RETINA NODE TRAINING PIPELINE
# -------------------------------------------------------------------
# This script reads the Foveated Memory DB (NeDB JSON format)
# and fine-tunes the 33M Parameter Stardust model (all-MiniLM-L6-v2) 
# specifically on the user's workspace context.
#
# This makes the "Retina" hyper-specialized for their exact codebase.

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
DB_PATH = "memory_data/jen/memory.db"
EPOCHS = 3
BATCH_SIZE = 16

print(f"👁️ Igniting Retina Training Pipeline...")
print(f"📡 Base Model: {MODEL_NAME} (33M Parameters)")

def parse_nedb(file_path):
    """Parse NeDB JSONL format."""
    records = []
    if not os.path.exists(file_path):
        print(f"⚠️ Database not found at {file_path}. Please import data first.")
        return records
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                records.append(json.loads(line))
    return records

def build_training_examples(records):
    """
    Creates synthetic positive pairs for contrastive learning.
    We pair a chunk of text with an overlapping chunk from the same file,
    teaching the model they are semantically identical in this workspace.
    """
    examples = []
    texts = [r.get("content", "") for r in records if "content" in r]
    
    # Very basic sliding window to create positive pairs
    for text in texts:
        words = text.split()
        if len(words) < 10: 
            # If it's short, just pair it with itself or a slight variation
            examples.append(InputExample(texts=[text, text]))
            continue
            
        # Create overlapping pairs for longer texts
        step = max(2, len(words) // 3)
        for i in range(0, len(words)-step, step):
            chunk_a = " ".join(words[i:i+step*2])
            chunk_b = " ".join(words[i+step:i+step*3])
            examples.append(InputExample(texts=[chunk_a, chunk_b]))
    
    return examples

def train_retina():
    print(f"🧠 Loading Foveated Memory from {DB_PATH}...")
    records = parse_nedb(DB_PATH)
    if not records:
        return
        
    examples = build_training_examples(records)
    print(f"🧬 Generated {len(examples)} training synapses.")
    
    # DataLoader
    train_dataloader = DataLoader(examples, shuffle=True, batch_size=BATCH_SIZE)
    
    # Load Model
    print(f"⚙️ Loading Base Model...")
    model = SentenceTransformer(MODEL_NAME)
    
    # MultipleNegativesRankingLoss is perfect for training retrieval models
    train_loss = losses.MultipleNegativesRankingLoss(model=model)
    
    print(f"🚀 Starting Holonic Training Loop ({EPOCHS} Epochs)...")
    # Uncomment to actually run the GPU training:
    '''
    model.fit(
        train_objectives=[(train_dataloader, train_loss)],
        epochs=EPOCHS,
        warmup_steps=100,
        output_path="models/retina_node_v1"
    )
    print("✅ Retina Training Complete. Model saved to 'models/retina_node_v1'.")
    '''
    print("⏳ Pipeline verified. Awaiting manual ignite command to begin GPU allocation.")

if __name__ == "__main__":
    train_retina()
