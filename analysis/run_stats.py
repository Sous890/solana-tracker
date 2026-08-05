"""Run the REAL realised_stats on both framings, per wallet."""
import sys, pandas as pd
sys.path.insert(0, __import__("os").path.dirname(__file__))
from calibrate import realised_stats

for wallet in sys.argv[1:]:
    print("=" * 72)
    print(wallet)
    for label, path in (("PER TRANCHE (raw export)", f"exports/{wallet}.csv"),
                        ("PER DECISION (aggregated)", f"exports/{wallet}.decisions.csv")):
        df = pd.read_csv(path)
        print(f"\n--- {label} ---")
        try:
            print(realised_stats(df).summary())
        except ValueError as e:
            print(f"  raised: {e}")
    print()
