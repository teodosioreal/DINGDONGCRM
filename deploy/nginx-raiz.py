#!/usr/bin/env python3
"""Troca os blocos "location" do server HTTPS do odingdong.tech pelos do CRM na raiz.

Uso: python3 nginx-raiz.py ARQUIVO_NGINX MODELO_LOCATIONS [DOMINIO]
Escreve o resultado na saída padrão (não mexe no arquivo). Mexe só no bloco
"server" que tem o server_name do domínio E "listen 443"; os outros (porta 80,
outros domínios no mesmo arquivo) ficam exatamente como estão.
"""
import re
import sys


def blocos(texto, ini, fim):
    """Acha os blocos { } diretamente dentro de texto[ini:fim]. Devolve [(começo da linha, fim do bloco, cabeçalho)]."""
    saida = []
    i = ini
    profundidade = 0
    comeco = None
    while i < fim:
        c = texto[i]
        if c == '#':  # comentário até o fim da linha
            j = texto.find('\n', i)
            i = fim if j < 0 or j > fim else j
            continue
        if c in '"\'':  # texto entre aspas
            j = texto.find(c, i + 1)
            i = (j if j >= 0 else fim) + 1
            continue
        if c == '{':
            if profundidade == 0:
                # cabeçalho = do fim da instrução anterior (; { } ou começo) até aqui
                k = i - 1
                while k >= ini and texto[k] not in ';{}\n':
                    k -= 1
                comeco = texto.rfind('\n', ini, i) + 1 if texto.rfind('\n', ini, i) >= ini else ini
                cab = texto[k + 1:i].strip()
                # junta linhas anteriores do mesmo cabeçalho (raro), começando na linha do cabeçalho
                comeco = texto.rfind('\n', ini, k + 1) + 1 if k >= ini else ini
                saida.append([comeco, None, cab])
            profundidade += 1
        elif c == '}':
            profundidade -= 1
            if profundidade == 0:
                fim_bloco = i + 1
                saida[-1][1] = fim_bloco
            if profundidade < 0:
                raise SystemExit('chaves { } desencontradas no arquivo')
        i += 1
    if profundidade != 0:
        raise SystemExit('chaves { } desencontradas no arquivo')
    return [tuple(b) for b in saida]


def main():
    arquivo, modelo = sys.argv[1], sys.argv[2]
    dominio = sys.argv[3] if len(sys.argv) > 3 else 'odingdong.tech'
    texto = open(arquivo, encoding='utf-8').read()
    novos = open(modelo, encoding='utf-8').read()
    # tira os comentários do modelo e indenta com 4 espaços
    linhas = [l for l in novos.splitlines() if not l.lstrip().startswith('#')]
    novos = '\n'.join(('    ' + l) if l.strip() else '' for l in linhas).strip('\n') + '\n'

    servidores = [b for b in blocos(texto, 0, len(texto)) if b[2] == 'server']
    alvos = []
    for ini, fim, _ in servidores:
        corpo = texto[ini:fim]
        sem_coment = re.sub(r'#[^\n]*', '', corpo)
        tem_nome = re.search(r'^\s*server_name\s[^;]*\b' + re.escape(dominio) + r'\b', sem_coment, re.M)
        tem_443 = re.search(r'^\s*listen\s[^;]*\b443\b', sem_coment, re.M)
        if tem_nome and tem_443:
            alvos.append((ini, fim))
    if len(alvos) != 1:
        raise SystemExit(f'esperava 1 bloco server HTTPS do {dominio}, achei {len(alvos)}. Nada foi mudado.')
    ini, fim = alvos[0]
    abre = texto.index('{', ini) + 1
    locs = [b for b in blocos(texto, abre, fim - 1) if b[2].startswith('location')]
    if not locs:
        raise SystemExit('o bloco HTTPS não tem nenhum "location". Nada foi mudado.')
    for _, _, cab in locs:
        print(f'  sai do domínio: {cab}', file=sys.stderr)
    # remove de trás para frente, tirando também a quebra de linha e linhas vazias logo depois
    resultado = texto
    for b_ini, b_fim, _ in reversed(locs):
        while b_fim < len(resultado) and resultado[b_fim] in ' \t':
            b_fim += 1
        if b_fim < len(resultado) and resultado[b_fim] == '\n':
            b_fim += 1
        while resultado.startswith('\n', b_fim) or re.match(r'[ \t]+\n', resultado[b_fim:]):
            b_fim = resultado.index('\n', b_fim) + 1
        resultado = resultado[:b_ini] + resultado[b_fim:]
    pos = locs[0][0]
    resultado = resultado[:pos] + novos + '\n' + resultado[pos:]
    sys.stdout.write(resultado)


if __name__ == '__main__':
    main()
