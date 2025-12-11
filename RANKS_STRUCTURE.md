# Структура рангов и дивизионов

## Полная структура рангов в League of Legends

### Ранги с 4 дивизионами (tier 1-4)

Каждый из этих рангов имеет 4 дивизиона (I, II, III, IV), где I - высший дивизион:

1. **IRON** - tier {1, 2, 3, 4}
   - IRON I (высший)
   - IRON II
   - IRON III
   - IRON IV (низший)

2. **BRONZE** - tier {1, 2, 3, 4}
   - BRONZE I (высший)
   - BRONZE II
   - BRONZE III
   - BRONZE IV (низший)

3. **SILVER** - tier {1, 2, 3, 4}
   - SILVER I (высший)
   - SILVER II
   - SILVER III
   - SILVER IV (низший)

4. **GOLD** - tier {1, 2, 3, 4}
   - GOLD I (высший)
   - GOLD II
   - GOLD III
   - GOLD IV (низший)

5. **PLATINUM** - tier {1, 2, 3, 4}
   - PLATINUM I (высший)
   - PLATINUM II
   - PLATINUM III
   - PLATINUM IV (низший)

6. **EMERALD** - tier {1, 2, 3, 4}
   - EMERALD I (высший)
   - EMERALD II
   - EMERALD III
   - EMERALD IV (низший)

7. **DIAMOND** - tier {1, 2, 3, 4}
   - DIAMOND I (высший)
   - DIAMOND II
   - DIAMOND III
   - DIAMOND IV (низший)

### Ранги с 1 дивизионом (tier 1)

Эти ранги имеют только один дивизион (I):

8. **MASTER** - tier {1}
   - MASTER I

9. **GRANDMASTER** - tier {1}
   - GRANDMASTER I

10. **CHALLENGER** - tier {1}
    - CHALLENGER I

## API Endpoints для сбора данных

### Для рангов с дивизионами (Iron - Diamond)

```
GET /lol/league-exp/v4/entries/RANKED_SOLO_5x5/{TIER}/{DIVISION}?page={page}
```

Примеры:
- `/lol/league-exp/v4/entries/RANKED_SOLO_5x5/IRON/I?page=1`
- `/lol/league-exp/v4/entries/RANKED_SOLO_5x5/GOLD/III?page=1`
- `/lol/league-exp/v4/entries/RANKED_SOLO_5x5/DIAMOND/IV?page=1`

### Для Master и Grandmaster

```
GET /lol/league/v4/entries/RANKED_SOLO_5x5/{TIER}?page={page}
```

Примеры:
- `/lol/league/v4/entries/RANKED_SOLO_5x5/MASTER?page=1`
- `/lol/league/v4/entries/RANKED_SOLO_5x5/GRANDMASTER?page=1`

### Для Challenger

```
GET /lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5
```

## Итого для сбора данных

**Всего комбинаций рангов и дивизионов:**
- 7 рангов × 4 дивизиона = 28 комбинаций (Iron - Diamond)
- 3 ранга × 1 дивизион = 3 комбинации (Master, Grandmaster, Challenger)
- **Всего: 31 комбинация** для сбора данных

## Структура в базе данных

### tracked_players
- `tier`: IRON, BRONZE, SILVER, GOLD, PLATINUM, EMERALD, DIAMOND, MASTER, GRANDMASTER, CHALLENGER
- `division`: I, II, III, IV (для рангов с дивизионами), I (для Master+)

### match_participants_stats
- `tier`: ранг игрока в матче (нормализован: IRON, BRONZE, SILVER, GOLD, PLATINUM, EMERALD, DIAMOND, MASTER, GRANDMASTER, CHALLENGER)

### champion_stats_aggregated
- `tier`: ранг для агрегации статистики (нормализован: IRON, BRONZE, SILVER, GOLD, PLATINUM, EMERALD, DIAMOND, MASTER, GRANDMASTER, CHALLENGER)
- Агрегация происходит по рангу без учета дивизиона (все дивизионы одного ранга объединяются)

