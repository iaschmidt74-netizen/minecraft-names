# MC Name Sniper

Scant automatisch zeldzame Minecraft Java-namen via de officiële Mojang-API en laat zien welke namen vrijkomen.

- **Welke namen**: alle namen van 3 tekens (~50k), ~11.900 waardevolle namen van 4 tekens (echte 4-letterwoorden + uitspreekbare medeklinker-klinker-medeklinker-klinker zoals `nova`) en ~7.700 Engelse woorden (5+ letters). Samen ~70k namen.
- **Hoe**: GitHub Actions draait elk uur ~52 minuten (`.github/workflows/scan.yml`). Een naam die eerder bezet was en nu vrij is, wordt dubbel gecontroleerd. Daarna komt hij bovenaan de site en gaat er een Discord-bericht uit.
- **Tempo**: Mojang laat ~1.000 namen per minuut toe, vanaf GitHub ~675 per minuut, dus alles is in ~1,75 uur rond. De eerste ronde is een nulmeting; pas daarna kunnen namen "vrijkomen".
- **Snelle lijst**: namen die de scanner zelf ziet veranderen (vrijkomen of geclaimd worden) gaan op een snelle lijst. De top 300 (plus alle nu vrije namen) wordt elke minuut gecheckt.
- **Status**: staat in de branch `state` en wordt elke run overschreven.
- **Site**: `site/index.html`, gepubliceerd via GitHub Pages.

## Instellingen
- Discord: repository-secret `DISCORD_WEBHOOK` = webhook-URL van je kanaal.

## Lokaal testen
```sh
TIME_BUDGET_MIN=1 node scanner/scan.mjs          # korte scan
FAKE_FREE=aaa TIME_BUDGET_MIN=0.1 node scanner/scan.mjs   # doe alsof 'aaa' vrij is
```

Let op: een naam die vrij lijkt, kan door Mojang geblokkeerd zijn. Dat zie je pas zeker in de launcher.
