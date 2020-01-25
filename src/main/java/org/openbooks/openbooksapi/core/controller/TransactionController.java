package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.model.Journal;
import org.openbooks.openbooksapi.core.model.Transaction;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.persistence.EntityExistsException;

@RestController
public class TransactionController {

    @Autowired
    private Journal journal;

    @GetMapping("/transactions/{id}")
    public Transaction getTransactionById(@PathVariable Long id) {
        return journal.getTransactionById(id).get();
    }

    @PostMapping("/transactions")
    public ResponseEntity<Transaction> createTransaction(@RequestBody Transaction transaction) {
        // throw error if transaction exists
        if (!transaction.idIsNull() && journal.getTransactionById(transaction.getId()).isPresent()) {
            throw new EntityExistsException("Transaction with ID " + transaction.getId() + " already exists");
        }

        // persist updates and return new object
        return ResponseEntity.ok().body(journal.commitTransaction(transaction));
    }

    @PutMapping("/transactions")
    public ResponseEntity<Transaction> updateTransaction(@RequestBody Transaction transaction) {
        // check if id exists, will throw error if account doesn't exist
        getTransactionById(transaction.getId());

        // persist updates and return updated object
        return ResponseEntity.ok().body(journal.updateTransaction(transaction));
    }
}
