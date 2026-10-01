-- Cópia (SÓ LEITURA) do banco da Evolution para o CRM: etiquetas e marcações e a
-- ligação "id escondido (LID) → número" dos números que estão no CRM.
-- Variáveis: :inst (nomes das instâncias do CRM, separados por vírgula) e :esq (esquema).
SET search_path TO :"esq";
SELECT json_build_object(
  'geradoEm', now(),
  'etiquetas', COALESCE((
    SELECT json_agg(json_build_object('instancia', i.name, 'id', l."labelId", 'nome', l.name, 'cor', l.color))
    FROM "Label" l JOIN "Instance" i ON i.id = l."instanceId"
    WHERE i.name = ANY(string_to_array(:'inst', ','))), '[]'::json),
  'conversas', COALESCE((
    SELECT json_agg(json_build_object('instancia', i.name, 'jid', c."remoteJid", 'labels', c.labels))
    FROM "Chat" c JOIN "Instance" i ON i.id = c."instanceId"
    WHERE i.name = ANY(string_to_array(:'inst', ','))
      AND jsonb_typeof(c.labels) = 'array' AND jsonb_array_length(c.labels) > 0), '[]'::json),
  'mapaLid', COALESCE((
    SELECT json_agg(json_build_object('instancia', x.instancia, 'lid', x.lid, 'fone', x.fone))
    FROM (
      SELECT DISTINCT i.name AS instancia, m.key->>'remoteJid' AS lid, m.key->>'remoteJidAlt' AS fone
      FROM "Message" m JOIN "Instance" i ON i.id = m."instanceId"
      WHERE i.name = ANY(string_to_array(:'inst', ','))
        AND m.key->>'remoteJid' LIKE '%@lid' AND m.key->>'remoteJidAlt' LIKE '%@s.whatsapp.net'
      UNION
      SELECT DISTINCT i.name, m.key->>'remoteJidAlt', m.key->>'remoteJid'
      FROM "Message" m JOIN "Instance" i ON i.id = m."instanceId"
      WHERE i.name = ANY(string_to_array(:'inst', ','))
        AND m.key->>'remoteJidAlt' LIKE '%@lid' AND m.key->>'remoteJid' LIKE '%@s.whatsapp.net'
      UNION
      SELECT DISTINCT i.name, o.lid, o."remoteJid"
      FROM "IsOnWhatsapp" o
      JOIN "Chat" c ON c."remoteJid" = o.lid
      JOIN "Instance" i ON i.id = c."instanceId"
      WHERE i.name = ANY(string_to_array(:'inst', ','))
        AND o.lid LIKE '%@lid' AND o."remoteJid" LIKE '%@s.whatsapp.net'
    ) x), '[]'::json)
);
