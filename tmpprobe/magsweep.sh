#!/bin/bash
# 각 탄창을 "시작 탄창"으로 강제해 진짜 세기를 잰다 (STARTER_MAGAZINE 을 잠시 바꿔치기).
cd /home/user/GunBalatro
F=src/core/data/magazines.ts
cp $F /tmp/magbak.ts
for m in m1 m2 m3 m4 m5 m6 m7 m8 m9 m10; do
  sed -i "s|^export const STARTER_MAGAZINE: Magazine = MAG_BY_ID\['.*'\]|export const STARTER_MAGAZINE: Magazine = MAG_BY_ID['$m']|" $F
  R=$(npx tsx src/sim/cli.ts --runs=200 --skill=greedy --no-order-analysis 2>&1 | grep -E "^보통\(greedy\)" | head -1)
  echo "$m  $R"
done
cp /tmp/magbak.ts $F
