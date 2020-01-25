package org.openbooks.openbooksapi.core.repository;

import org.openbooks.openbooksapi.core.model.Transaction;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;


@Repository
public interface TransactionRepository extends JpaRepository<Transaction, Long> {

    public List<Transaction> findAllByAccountId(Long accountId);
}