# Funding matching, referrals, allocation fairness and cost reporting

## BNK-031 funding matching and referrals

`createFundingCatalog` compiles synthetic programs (grant, loan referral, accelerator, investor referral) with explicit criteria and a mandatory referral-compensation disclosure. `FundingReferrals.match` checks stage, sector, region, independently verified claim count (BNK-030) and revenue ceiling, lists unmet criteria and attaches notices: investment opportunities are not deposits, are not insured and are offered only by separately authorized providers; loan referrals are not credit decisions. `refer` requires the founder's own human identity, an affirmative action, acknowledged notices, eligibility and an explicit choice of shareable fields; only those fields are shared. Referrals never accept or arrange investments or credit.

## BNK-032 allocation fairness and cost reporting

`allocateFairly` performs a deterministic weighted max-min fair (water-filling) allocation of integer capacity: nobody receives more than they asked for, spare capacity is redistributed by weight, remainders go to the largest fractional shares with project-ID tie-breaks, and Jain's fairness index (x1000) is reported over weight-normalized allocations. `costReport` produces a tenant-scoped, windowed cost breakdown by project and agent with each project's share of spend, for use with BNK-015 run costs.
