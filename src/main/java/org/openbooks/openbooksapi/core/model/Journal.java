package org.openbooks.openbooksapi.core.model;

import java.util.List;
import java.util.Optional;

import org.springframework.data.repository.CrudRepository;

public interface Journal {

    public CrudRepository<Transaction, String> getTransactionRepository();

    public Transaction commitTransaction(Transaction transaction);

    public Transaction updateTransaction(Transaction transaction);

    public List<Transaction> getTransactionsForAccount(Long accountId);

    public Optional<Transaction> getTransactionById(Long id);
}

