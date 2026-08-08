import torch
import os
from unsloth import FastVisionModel

# Canonical output directory — all generated XRLF models go here
XRLF_OUTPUT_DIR = os.path.expanduser(r"~\.cache\huggingface\hub\lumax-forge\XRLF")
os.makedirs(XRLF_OUTPUT_DIR, exist_ok=True)

# ==============================================================================
# XRLF BONE MODEL FINETUNING SCRIPT (Qwen2.5-VL-3B to MoQ GGUF)
# 
# This script uses Unsloth to:
# 1. Load the Qwen2.5-VL-3B base model in 4-bit quantization (to save VRAM).
# 2. Apply LoRA adapters to both the language model and the vision projector (MMPROJ).
# 3. Setup a basic HuggingFace Trainer loop (you will plug your dataset here).
# 4. EXPORT directly to a Mixed Quantization (MoQ) GGUF file (q4_k_m).
#
# Requirements: pip install unsloth unsloth-vision
# ==============================================================================

def main():
    max_seq_length = 4096 # You can increase this if you have more VRAM
    dtype = None # Auto-detects bf16/fp16
    load_in_4bit = True # Loads the base model in 4-bit to save massive VRAM during training

    print("1. Loading Qwen2.5-VL-3B Base Model...")
    model, tokenizer = FastVisionModel.from_pretrained(
        model_name = "Qwen/Qwen2.5-VL-3B-Instruct",
        load_in_4bit = load_in_4bit,
        use_gradient_checkpointing = "unsloth",
    )

    print("2. Applying LoRA Adapters (Targeting Attention and Vision Projections)...")
    model = FastVisionModel.get_peft_model(
        model,
        finetune_vision = True, # Critical: Finetunes the vision projector (MMPROJ)
        finetune_language = True,
        finetune_attention_modules = True,
        finetune_mlp_modules = True,
        r = 16, # LoRA Rank (higher = smarter but slower/more VRAM)
        lora_alpha = 16,
        lora_dropout = 0,
        bias = "none",
        random_state = 3407,
        use_rslora = False,
        loftq_config = None,
    )

    # ---------------------------------------------------------
    # TODO: Add your dataset here!
    # Unsloth VLMs expect a specific format, e.g.:
    # dataset = load_dataset("your_dataset")
    # ---------------------------------------------------------

    print("3. Setting up Trainer...")
    from trl import SFTTrainer
    from transformers import TrainingArguments

    # Example Trainer setup (uncomment when you have a dataset)
    '''
    trainer = SFTTrainer(
        model = model,
        tokenizer = tokenizer,
        train_dataset = dataset,
        dataset_text_field = "text",
        max_seq_length = max_seq_length,
        dataset_num_proc = 2,
        packing = False,
        args = TrainingArguments(
            per_device_train_batch_size = 2,
            gradient_accumulation_steps = 4,
            warmup_steps = 5,
            max_steps = 60,
            learning_rate = 2e-4,
            fp16 = not torch.cuda.is_bf16_supported(),
            bf16 = torch.cuda.is_bf16_supported(),
            logging_steps = 1,
            optim = "adamw_8bit",
            weight_decay = 0.01,
            lr_scheduler_type = "linear",
            seed = 3407,
            output_dir = os.path.join(XRLF_OUTPUT_DIR, "training-checkpoints"),
            report_to = "none",
        ),
    )

    print("4. Starting Fine-Tuning...")
    trainer.train()
    '''

    print("5. Exporting to MoQ GGUF (q4_k_m)...")
    # This single line merges the LoRA into the base weights, quantizes the language model 
    # to q4_k_m, and also quantizes the mmproj (Vision Projector) appropriately!
    gguf_out = os.path.join(XRLF_OUTPUT_DIR, "qwen2.5-vl-3b-xrl-bone")
    model.save_pretrained_gguf(
        gguf_out,
        tokenizer,
        quantization_method = "q4_k_m"
    )

    print(f"Done! Check '{gguf_out}' for your .gguf and mmproj files.")

if __name__ == "__main__":
    main()
