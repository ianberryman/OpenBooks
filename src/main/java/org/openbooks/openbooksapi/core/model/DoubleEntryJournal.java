package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.TransactionRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.repository.CrudRepository;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.EntityManager;
import javax.persistence.PersistenceContext;
import java.util.List;
import java.util.Optional;


public class DoubleEntryJournal implements Journal {

    @Autowired
    private TransactionRepository tranRepo;

    @PersistenceContext
    private EntityManager entityMgr;

    @Override
    public CrudRepository<Transaction, String> getTransactionRepository() {
        // TODO Auto-generated method stub
        return null;
    }

    @Override
    public Transaction commitTransaction(Transaction transaction) {
        Account parent = entityMgr.getReference(Account.class, transaction.getAccountId());
        transaction.setAccount(parent);

        return tranRepo.save(transaction);
    }

    @Transactional
    @Override
    public Transaction updateTransaction(Transaction transaction) {
        Account parent = entityMgr.getReference(Account.class, transaction.getAccountId());
        transaction.setAccount(parent);

        entityMgr.refresh(tranRepo.saveAndFlush(transaction));
        return tranRepo.getOne(transaction.getId());
    }

    @Override
    public List<Transaction> getTransactionsForAccount(Long accountId) {
        return tranRepo.findAllByAccountId(accountId);
    }

    @Override
    public Optional<Transaction> getTransactionById(Long id) {
        return tranRepo.findById(id);
    }



}

