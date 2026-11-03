#!/bin/bash
# wait for the session-flat run to finish, then run the swing-hold run
cd /home/user/Zaluea/backtests
while [ ! -f results/mega2_GC_count.txt ]; do sleep 20; done
HOLD=1 python3 mega2.py NQ ES GC >> results/mega2_progress.log 2>&1
echo "HOLD RUN FINISHED" >> results/mega2_progress.log
