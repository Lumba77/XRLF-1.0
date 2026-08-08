import os
import sys

# Ensure project root is on the path
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from formats.xrlf_parser import XRLFParser
from formats.xrlf_packer import XRLFPacker
from formats.xrlf_schema import SectionType
import tempfile

def inject_draft(source_xrlf: str, draft_gguf: str, output_xrlf: str):
    print(f"Injecting draft model {draft_gguf} into {source_xrlf} -> {output_xrlf}")
    
    parser = XRLFParser.open(source_xrlf)
    
    # Initialize packer with the same headers
    packer = XRLFPacker(
        base_model_name=parser.manifest.header.base_model_name,
        xrl_source_model=parser.manifest.header.xrl_source_model,
        flags=parser.manifest.header.flags
    )
    
    tmpdir = tempfile.mkdtemp()
    
    # Extract and add CORE_GGUF
    if parser.has_section(SectionType.CORE_GGUF):
        core_path = os.path.join(tmpdir, "core.gguf")
        parser.extract_gguf(core_path)
        packer.add_gguf(core_path)
        
    # Extract and add MMPROJ
    if parser.has_section(SectionType.CORE_MMPROJ):
        mmproj_path = os.path.join(tmpdir, "mmproj.gguf")
        parser.extract_mmproj(mmproj_path)
        packer.add_mmproj(mmproj_path)
        
    # Add the NEW DRAFT GGUF
    packer.add_draft_gguf(draft_gguf)
    
    # Extract and add memory DB
    if parser.has_section(SectionType.XRL_MEMORY_DATA):
        memory_db_path = os.path.join(tmpdir, "memory.db")
        parser.extract_memory_db(memory_db_path)
        packer.add_memory_db(memory_db_path)
        
    # Add JSON sections
    for stype in [
        SectionType.XRL_PRINCIPLES,
        SectionType.XRL_GRAPH,
        SectionType.XRL_CLUSTERS,
        SectionType.XRL_PROFILES,
        SectionType.XRL_EXPANSION,
        SectionType.XRL_MM_HOOKS,
        SectionType.XRL_MEMORY_SCHEMA,
        SectionType.RUNTIME_META
    ]:
        if parser.has_section(stype):
            obj = parser.get_section_json(stype)
            packer._add_json_section(stype, obj)
            
    # Write the new file
    packer.write(output_xrlf)
    parser.close()
    
    print("\nInjection complete!")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("draft")
    parser.add_argument("output")
    args = parser.parse_args()
    
    inject_draft(args.source, args.draft, args.output)
