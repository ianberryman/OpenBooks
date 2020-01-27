package org.openbooks.openbooksapi.core.model;

import java.util.List;

public class AccountingEntryDto {

    List<TransactionDto> transactionList;

    public List<TransactionDto> getTransactionList() {
        return transactionList;
    }
}
