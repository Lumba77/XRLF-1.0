import json

def generate_distillation_dataset(output_path="conciseness_dataset.jsonl"):
    examples = [
        # Math & Logic
        {
            "instruction": "A store has 24 apples. They sell 7 in the morning and 5 in the afternoon. How many remain?",
            "output": "24 - 7 - 5 = 12. There are 12 apples remaining."
        },
        {
            "instruction": "Maria has 3 bags with 8 marbles each. She gives away 10 marbles. How many does she have?",
            "output": "(3 * 8) - 10 = 24 - 10 = 14. She has 14 marbles."
        },
        {
            "instruction": "A train travels 60 km/h. How far does it go in 2.5 hours?",
            "output": "60 km/h * 2.5 hours = 150 km. It goes 150 km."
        },
        {
            "instruction": "A rectangle is 12 m long and 7 m wide. What is its area?",
            "output": "12 m * 7 m = 84 square meters."
        },
        {
            "instruction": "Tom saves $15 every week. How much will he save in 8 weeks?",
            "output": "15 * 8 = 120. He will save $120."
        },
        
        # Science
        {
            "instruction": "Which of these is a conductor of electricity? (A) rubber (B) wood (C) copper (D) plastic",
            "output": "Copper is a metal and a good conductor of electricity. The answer is (C)."
        },
        {
            "instruction": "What is the largest planet in our solar system? (A) Earth (B) Saturn (C) Jupiter (D) Uranus",
            "output": "Jupiter is the largest planet in our solar system. The answer is (C)."
        },
        {
            "instruction": "Which process do plants use to make food? (A) respiration (B) digestion (C) photosynthesis (D) fermentation",
            "output": "Plants make food using photosynthesis. The answer is (C)."
        },
        {
            "instruction": "What is the chemical symbol for water? (A) WA (B) H2O (C) CO2 (D) O2",
            "output": "Water consists of two hydrogen atoms and one oxygen atom (H2O). The answer is (B)."
        },
        {
            "instruction": "Which layer of Earth is made of molten rock? (A) crust (B) mantle (C) inner core (D) outer core",
            "output": "The mantle is composed of molten rock (magma). The answer is (B)."
        },
        
        # General Knowledge (MMLU)
        {
            "instruction": "Who wrote 'Pride and Prejudice'? (A) Charlotte Brontë (B) Jane Austen (C) George Eliot (D) Mary Shelley",
            "output": "Jane Austen wrote 'Pride and Prejudice'. The answer is (B)."
        },
        {
            "instruction": "In which year did World War II end? (A) 1942 (B) 1944 (C) 1945 (D) 1947",
            "output": "World War II ended in 1945. The answer is (C)."
        },
        {
            "instruction": "What is the currency of Japan? (A) Yuan (B) Won (C) Ringgit (D) Yen",
            "output": "The currency of Japan is the Yen. The answer is (D)."
        },
        {
            "instruction": "The Pythagorean theorem applies to: (A) any triangle (B) right triangles (C) equilateral triangles (D) obtuse triangles",
            "output": "The Pythagorean theorem (a^2 + b^2 = c^2) only applies to right triangles. The answer is (B)."
        },
        {
            "instruction": "What programming language was created by Guido van Rossum? (A) Java (B) Ruby (C) Python (D) C++",
            "output": "Python was created by Guido van Rossum. The answer is (C)."
        }
    ]

    with open(output_path, "w", encoding="utf-8") as f:
        for ex in examples:
            record = {
                "messages": [
                    {"role": "system", "content": "Think step by step. Give a concise final answer at the end. For multiple choice questions, state the letter clearly."},
                    {"role": "user", "content": ex["instruction"]},
                    {"role": "assistant", "content": ex["output"]}
                ]
            }
            f.write(json.dumps(record) + "\n")

    print(f"✅ Generated {len(examples)} highly concise training examples at {output_path}")

if __name__ == "__main__":
    generate_distillation_dataset()
