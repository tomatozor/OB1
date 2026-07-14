# Rotation des cles serveur

Ce runbook couvre `MCP_CLIENT_KEYS`, le mode legacy `MCP_ACCESS_KEY`, les
connecteurs utilisant `?key=` et `REVIEWER_ACCESS_KEY`. Il suppose une machine
operateur de confiance, la CLI Supabase connectee et un `PROJECT_REF` explicite.
Ne jamais copier une cle dans un ticket, un chat, un log, une capture ou un
commit.

## Cadence et declencheurs

- `MCP_CLIENT_KEYS` : tous les 90 jours au maximum, et immediatement apres perte
  d'un poste, depart d'un operateur, exposition suspectee ou changement de
  fournisseur.
- `REVIEWER_ACCESS_KEY` : tous les 60 a 90 jours, car elle permet la promotion de
  memoires en instruction-grade.
- `MCP_ACCESS_KEY` legacy : tous les 90 jours tant qu'elle existe ; priorite a sa
  suppression au profit du registre multi-clients.
- Rotation d'urgence : revoquer d'abord, investiguer ensuite. Une indisponibilite
  courte est preferable au maintien d'une cle suspecte.

Tenir un inventaire hors depot : `client_id`, proprietaire, usage, date de
creation, derniere rotation et date cible. Ne jamais y stocker la cle brute.

## Generer une cle et son empreinte

Dans un shell sans tracing (`set +x`) :

```bash
set +x
umask 077
NEW_KEY="$(openssl rand -hex 32)"
NEW_KEY_SHA256="$(printf '%s' "$NEW_KEY" | openssl dgst -sha256 -r | awk '{print $1}')"
test "${#NEW_KEY}" -eq 64
test "${#NEW_KEY_SHA256}" -eq 64
```

`NEW_KEY` est la valeur a remettre une seule fois au client par un canal sur.
`NEW_KEY_SHA256` est la seule valeur a placer dans `MCP_CLIENT_KEYS`. Conserver
les variables uniquement pendant la bascule, puis executer :

```bash
unset NEW_KEY NEW_KEY_SHA256 MCP_CLIENT_KEYS_JSON
```

## Rotation multi-clients sans interruption

Le registre refuse deux entrees portant le meme `client_id`. Pour faire
coexister temporairement ancienne et nouvelle cle, utiliser un nouvel identifiant
versionne, par exemple `desktop-agent-v2`.

1. Lire le registre actuel depuis le gestionnaire de secrets, jamais depuis les
   logs. Ajouter l'empreinte sans retirer l'ancienne entree :

   ```json
   [
     { "client_id": "desktop-agent", "key_sha256": "<OLD_SHA256>" },
     { "client_id": "desktop-agent-v2", "key_sha256": "<NEW_SHA256>" }
   ]
   ```

2. Charger la valeur via un fichier temporaire pour eviter de mettre le JSON
   dans l'historique du shell :

   ```bash
   set +x
   umask 077
   ROTATION_ENV="$(mktemp)"
   printf 'MCP_CLIENT_KEYS=%s\n' "$MCP_CLIENT_KEYS_JSON" > "$ROTATION_ENV"
   supabase secrets set --project-ref "$PROJECT_REF" --env-file "$ROTATION_ENV"
   rm -f "$ROTATION_ENV"
   unset ROTATION_ENV
   ```

3. Redeployer la source canonique et verifier la nouvelle cle :

   ```bash
   cd server
   bash scripts/deploy.sh --project-ref "$PROJECT_REF"
   ```

4. Basculer le client vers `NEW_KEY`. Faire la probe 200 ci-dessous depuis le
   chemin reseau reel du client.
5. Observer une fenetre adaptee au client (minimum 15 minutes ; un cycle complet
   pour une automation periodique), puis retirer l'entree
   `desktop-agent`/ancienne empreinte du registre.
6. Recharger le secret, redeployer, verifier `200` avec la nouvelle cle et `401`
   avec l'ancienne. Mettre a jour l'inventaire.

Ne jamais laisser les deux entrees au-dela de la fenetre de bascule.

## Rotation legacy et connecteurs `?key=`

### Connecteur URL deja dans `MCP_CLIENT_KEYS`

Utiliser exactement la rotation multi-clients ci-dessus. La nouvelle cle peut
coexister sous `client_id-v2`, meme si elle est transportee dans `?key=`. Mettre
a jour l'URL du connecteur, verifier, puis retirer l'ancienne entree.

Le transport URL reste risque : desactiver `MCP_ALLOW_QUERY_KEY` des que tous les
clients savent envoyer `Authorization: Bearer` ou `x-brain-key`.

### Mode pur `MCP_ACCESS_KEY`

Le mode legacy n'accepte qu'une seule cle : il n'existe pas de bascule sans
interruption. Planifier une courte fenetre, generer une nouvelle cle, mettre a
jour `MCP_ACCESS_KEY`, redeployer, puis changer immediatement tous les clients.

Attention : l'API REST Agent Memory et plusieurs workers utilisent encore
`MCP_ACCESS_KEY`. Une rotation legacy doit donc inclure leurs clients et leur
redeploiement. Pour l'API REST :

```bash
cd server
bash scripts/deploy.sh --with-agent-memory --project-ref "$PROJECT_REF"
```

Si `MCP_CLIENT_KEYS` et `MCP_ACCESS_KEY` sont tous deux presents sur le MCP, le
registre multi-clients a priorite et il n'y a aucun fallback vers la cle legacy.
Migrer chaque connecteur URL vers une entree dediee avant de supprimer le legacy.

## Rotation de `REVIEWER_ACCESS_KEY`

Cette cle doit etre differente de toutes les cles MCP. Le serveur ne prend en
charge qu'une reviewer key ; la bascule coordonnee peut provoquer une courte
indisponibilite des seules actions `confirm`, `approve`, `merge` et `supersede`.

1. Generer une nouvelle cle de 32 octets avec la procedure ci-dessus. Ici, la
   valeur brute est stockee dans le secret ; son empreinte n'est pas utilisee.
2. Charger le secret sans l'exposer dans les arguments :

   ```bash
   set +x
   umask 077
   REVIEWER_ENV="$(mktemp)"
   printf 'REVIEWER_ACCESS_KEY=%s\n' "$NEW_KEY" > "$REVIEWER_ENV"
   supabase secrets set --project-ref "$PROJECT_REF" --env-file "$REVIEWER_ENV"
   rm -f "$REVIEWER_ENV"
   unset REVIEWER_ENV
   ```

3. Redeployer les deux fonctions :

   ```bash
   cd server
   bash scripts/deploy.sh --with-agent-memory --project-ref "$PROJECT_REF"
   ```

4. Effectuer la probe reviewer non mutante ci-dessous, mettre a jour les
   interfaces humaines, puis detruire l'ancienne cle.

## Probes post-rotation

Definir les URLs sans y inclure de secret :

```bash
MCP_URL="https://${PROJECT_REF}.supabase.co/functions/v1/open-brain-mcp"
AGENT_MEMORY_URL="https://${PROJECT_REF}.supabase.co/functions/v1/agent-memory-api"
```

### MCP : nouvelle cle 200, ancienne cle 401

```bash
probe_mcp() {
  curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
    --request POST "$MCP_URL" \
    --header "Authorization: Bearer $1" \
    --header 'Content-Type: application/json' \
    --header 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"rotation-probe","version":"1"}}}'
}

probe_mcp "$NEW_KEY"  # attendu : 200
probe_mcp "$OLD_KEY"  # attendu apres revocation : 401
```

### REST Agent Memory : cle d'acces 200, cle invalide 401

```bash
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --header "x-brain-key: $NEW_ACCESS_KEY" \
  "$AGENT_MEMORY_URL/health"  # attendu : 200

curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --header 'x-brain-key: deliberately-invalid' \
  "$AGENT_MEMORY_URL/health"  # attendu : 401
```

### Reviewer : probe non mutante

La reviewer key n'a pas de route health dediee. Cette requete utilise un UUID
factice et une auto-relation : avec une reviewer key valide, elle est rejetee
`400` avant tout RPC ; avec une cle invalide, elle est rejetee `403`. Aucun etat
n'est modifie.

```bash
CANARY_ID='00000000-0000-4000-8000-000000000001'
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --request PATCH "$AGENT_MEMORY_URL/memories/$CANARY_ID/review" \
  --header "x-brain-key: $NEW_ACCESS_KEY" \
  --header "x-reviewer-key: $NEW_REVIEWER_KEY" \
  --header 'Content-Type: application/json' \
  --data "{\"workspace_id\":\"rotation-probe\",\"action\":\"confirm\",\"actor_id\":\"rotation-probe\",\"related_memory_id\":\"$CANARY_ID\"}"
# attendu : 400
```

## Checklist de cloture

- [ ] Nouvelle cle forte et unique, remise par canal sur.
- [ ] Nouvelle empreinte ajoutee sans retirer l'ancienne trop tot.
- [ ] Deploiement termine avec la source canonique et suite verte.
- [ ] Probe nouvelle cle `200` depuis le client reel.
- [ ] Tous les clients et crons inventaries ont bascule.
- [ ] Ancienne entree/cle retiree du gestionnaire de secrets.
- [ ] Probe ancienne cle `401`.
- [ ] `MCP_ALLOW_QUERY_KEY` desactive si aucun connecteur ne l'exige.
- [ ] Aucun secret present dans historique, fichier temporaire, log ou ticket.
- [ ] Date, operateur, clients touches et resultat des probes consignes sans
  secret.
