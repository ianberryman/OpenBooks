package org.openbooks.openbooksapi.core.model;

import java.util.List;
import java.util.Optional;

public interface Journal<E extends AccountingEntry> {

    E commitAccountingEntry(E entry);

    E updateAccountingEntry(E entry);

    List<E> getAccountingEntries();

    Optional<E> getAccountingEntryById(Long entryId);

    List<Transaction> getTransactionsForAccount(Account account);

    Optional<Transaction> getTransactionById(Long id);
}

