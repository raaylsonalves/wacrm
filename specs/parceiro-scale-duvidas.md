# Dúvidas: API de parceiros ScaLE (v1)

1. **Serviços não agendáveis:** existe um campo como `agendavelOnline` em `/servicos`, para o bot não oferecer itens de uso interno (gorjeta, produto)? Ou a API já devolve só os agendáveis?

2. **Próximo horário livre:** hoje é um `/horarios` por barbeiro e por dia, com ~1,2–1,5 s por chamada. Dá para ter uma consulta agregada numa próxima versão, como `GET /horarios?unidadeId=...&servicoIds=...&de=...&ate=...&limite=5`, que devolva os próximos horários de qualquer barbeiro com o `barbeiroId` em cada um?

3. **Cancelar e remarcar:** há previsão para a próxima versão (`DELETE` / `PATCH /agendamentos/{id}`)?

4. **Agendamentos do cliente:** é possível ter um `GET /agendamentos?telefone=...` para consultar os horários futuros do cliente?

5. **Webhook:** há previsão de webhook para criado, cancelado, remarcado, concluído e falta, para manter o CRM sincronizado com mudanças feitas pela barbearia?

6. **Lembretes:** o ScaLE já envia lembrete ao cliente? Se sim, por qual canal?

7. **Dia sem horários:** quando `/horarios` volta vazio para uma data futura, dá para informar o motivo (`sem_expediente` ou `lotado`)?

8. **9º dígito:** o WhatsApp às vezes entrega o celular sem o 9 (`558599990000`). A API reconhece como o mesmo cliente de `5585999990000`?

9. **Nome do cliente:** o `cliente.nome` é obrigatório? Se o cliente já existe, o nome enviado substitui o cadastrado ou é ignorado?

10. **Fuso:** é possível incluir o fuso da unidade em `/unidades` (ex.: `America/Fortaleza`)?

11. **Chave:** a chave será sempre gerada pela barbearia e repassada ao parceiro, ou haverá um meio de o parceiro vincular as barbearias?
